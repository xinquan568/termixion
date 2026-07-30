// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-224: macOS Services — "New Termixion Tab Here".
//!
//! Two layers, deliberately split so the decisions are headless-testable and the AppKit
//! glue stays dumb:
//! - **Pure policy** (any platform): [`open_target_dirs`] normalizes raw service targets
//!   into tab working directories; [`paths_from_pasteboard_content`] is the decode policy
//!   over already-extracted pasteboard content (file URLs win; the plain-text path is only
//!   a fallback).
//! - **AppKit glue** (macOS): a `ServicesProvider` objc class whose `openTab:userData:error:`
//!   does dumb extraction (the `NSFilenamesPboardType` property list, else the pasteboard
//!   string) and hands the decoded directories to the callback registered via
//!   [`register_open_paths_provider`]. The `NSServices` declaration itself lives in the
//!   tauri shell's `Info.plist` (merged into the bundle by tauri-bundler).

use std::path::PathBuf;

/// Normalize raw service targets into tab working directories.
///
/// A file resolves to its **parent** directory; a directory (including package directories
/// like `Foo.app` and symlinks whose target is a directory — `std::fs::metadata` follows
/// links) passes through unchanged (no canonicalization); a missing path or broken symlink
/// is dropped; duplicates dedupe preserving first-seen order. Total on foreign input —
/// never panics.
pub fn open_target_dirs(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in paths {
        let dir = match std::fs::metadata(&p) {
            Ok(m) if m.is_dir() => p,
            Ok(_) => match p.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
                _ => continue,
            },
            Err(_) => continue,
        };
        if !out.contains(&dir) {
            out.push(dir);
        }
    }
    out
}

/// The decode policy over extracted pasteboard content: file paths extracted from the
/// pasteboard's file list win; the plain-text `text` is a fallback consulted **only when
/// no file paths decoded** (`NSSendTypes` declares `public.plain-text` as a secondary
/// type). Composes with [`open_target_dirs`], so the result is already normalized.
pub fn paths_from_pasteboard_content(urls: Vec<PathBuf>, text: Option<String>) -> Vec<PathBuf> {
    if !urls.is_empty() {
        return open_target_dirs(urls);
    }
    let Some(text) = text else {
        return Vec::new();
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    open_target_dirs(vec![PathBuf::from(trimmed)])
}

#[cfg(target_os = "macos")]
mod provider {
    //! The AppKit half: a dumb objc provider object. Extraction only — every decision
    //! (URL-vs-text policy, normalization) lives in the pure functions above.

    use std::path::PathBuf;
    use std::sync::OnceLock;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{NSApplication, NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::{NSArray, NSObject, NSString};

    /// The callback the provider hands decoded directories to. Boxed once at registration.
    type OpenPaths = Box<dyn Fn(Vec<PathBuf>) + Send + Sync + 'static>;

    pub(super) struct Ivars {
        pub(super) on_open: OpenPaths,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; the class is main-thread-only
        // (services messages arrive on the main thread) and defined exactly once.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "TermixionServicesProvider"]
        #[ivars = Ivars]
        pub(super) struct ServicesProvider;

        impl ServicesProvider {
            /// The `NSMessage = openTab` service handler (Info.plist `NSServices`). The
            /// historical signature returns nothing and reports errors through the out-
            /// pointer; we never write it — an empty selection is simply a no-op.
            #[unsafe(method(openTab:userData:error:))]
            fn open_tab(
                &self,
                pboard: &NSPasteboard,
                _user_data: Option<&NSString>,
                _error: *mut *mut NSString,
            ) {
                let dirs = super::paths_from_pasteboard_content(
                    filenames_from(pboard),
                    string_from(pboard),
                );
                if !dirs.is_empty() {
                    (self.ivars().on_open)(dirs);
                }
            }
        }
    );

    impl ServicesProvider {
        fn new(mtm: MainThreadMarker, on_open: OpenPaths) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { on_open });
            // SAFETY: plain NSObject init on an allocated+ivar-initialized instance.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Extract the `NSFilenamesPboardType` property list (an `NSArray<NSString>` of POSIX
    /// paths).
    ///
    /// Documented deviation from the planned `readObjectsForClasses`/FileURLsOnly URL read:
    /// our `Info.plist` `NSSendTypes` names `NSFilenamesPboardType` as the PRIMARY send
    /// type, so the services pasteboard for this handler carries exactly this property
    /// list (Apple, Services Implementation Guide — the send types define the pasteboard
    /// representations); reading it directly avoids the URL-class round-trip and matches
    /// what we declared. Verified against the real Finder invocation by the operator
    /// steps in the PR (the packaged-bundle path is the only place this code can run).
    fn filenames_from(pboard: &NSPasteboard) -> Vec<PathBuf> {
        let ty = NSString::from_str("NSFilenamesPboardType");
        let Some(plist) = pboard.propertyListForType(&ty) else {
            return Vec::new();
        };
        let Ok(list) = plist.downcast::<NSArray>() else {
            return Vec::new();
        };
        list.iter()
            .filter_map(|obj: Retained<AnyObject>| obj.downcast::<NSString>().ok())
            .map(|s| PathBuf::from(s.to_string()))
            .collect()
    }

    /// Extract the plain-string content (the `public.plain-text` fallback).
    fn string_from(pboard: &NSPasteboard) -> Option<String> {
        // SAFETY: stringForType returns an autoreleased string or nil.
        unsafe { pboard.stringForType(NSPasteboardTypeString) }.map(|s| s.to_string())
    }

    /// Idempotence guard: the provider registers once per process; later calls are no-ops.
    ///
    /// Documented deviation from the planned `OnceLock<Retained<ServicesProvider>>`: a
    /// `MainThreadOnly` `Retained` is neither `Send` nor `Sync`, so it cannot live in a
    /// static `OnceLock` (the static would need `T: Send + Sync`). The unit guard plus
    /// `mem::forget` below pins the provider for the process lifetime with the same
    /// once-only semantics — the canonical objc2 pattern for main-thread singletons.
    static REGISTERED: OnceLock<()> = OnceLock::new();

    /// Register the app's services provider. Returns `false` (without touching AppKit)
    /// when not on the main thread or when already registered.
    pub fn register_open_paths_provider(
        on_open: impl Fn(Vec<PathBuf>) + Send + Sync + 'static,
    ) -> bool {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        if REGISTERED.set(()).is_err() {
            return false;
        }
        let provider = ServicesProvider::new(mtm, Box::new(on_open));
        let app = NSApplication::sharedApplication(mtm);
        // SAFETY: main thread (mtm); the provider outlives the registration — NSApp holds
        // the services provider, and the mem::forget below pins our reference for the
        // process lifetime regardless (the provider is a process-singleton by design).
        unsafe { app.setServicesProvider(Some(&provider)) };
        std::mem::forget(provider);
        true
    }
}

#[cfg(target_os = "macos")]
pub use provider::register_open_paths_provider;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    /// A unique per-test fixture root under the system temp dir (no dev-dependency needed).
    fn fixture_root(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("trmx224-services-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        root
    }

    fn touch(p: &Path) {
        fs::write(p, b"x").expect("touch");
    }

    #[test]
    fn file_resolves_to_parent_dir_and_dir_passes_through() {
        let root = fixture_root("file-parent");
        let dir = root.join("proj");
        fs::create_dir(&dir).unwrap();
        let file = dir.join("main.rs");
        touch(&file);
        assert_eq!(
            open_target_dirs(vec![file, dir.clone()]),
            vec![dir],
            "file → parent; dir kept; the two dedupe to one entry"
        );
    }

    #[test]
    fn package_directory_is_a_directory() {
        let root = fixture_root("package");
        let app = root.join("Foo.app");
        fs::create_dir(&app).unwrap();
        assert_eq!(open_target_dirs(vec![app.clone()]), vec![app]);
    }

    #[test]
    fn missing_paths_and_broken_symlinks_drop() {
        let root = fixture_root("missing");
        let gone = root.join("never-existed");
        let broken = root.join("broken-link");
        std::os::unix::fs::symlink(root.join("target-gone"), &broken).unwrap();
        assert!(open_target_dirs(vec![gone, broken]).is_empty());
    }

    #[test]
    fn symlink_to_directory_is_kept_uncanonicalized() {
        let root = fixture_root("symlink-dir");
        let real = root.join("real");
        fs::create_dir(&real).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(
            open_target_dirs(vec![link.clone()]),
            vec![link],
            "metadata follows the link (is_dir), but the path is NOT canonicalized"
        );
    }

    #[test]
    fn dedupe_preserves_first_seen_order() {
        let root = fixture_root("dedupe");
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        let file_in_a = a.join("f.txt");
        touch(&file_in_a);
        // b, then a-via-file, then a directly, then b again → [b, a].
        assert_eq!(
            open_target_dirs(vec![b.clone(), file_in_a, a.clone(), b.clone()]),
            vec![b, a]
        );
    }

    #[test]
    fn root_file_without_parent_drops_instead_of_panicking() {
        // "/" is a directory (kept); a file directly under "/" resolves to "/".
        let out = open_target_dirs(vec![PathBuf::from("/")]);
        assert_eq!(out, vec![PathBuf::from("/")]);
    }

    #[test]
    fn urls_win_over_text() {
        let root = fixture_root("urls-win");
        let d1 = root.join("d1");
        let d2 = root.join("d2");
        fs::create_dir(&d1).unwrap();
        fs::create_dir(&d2).unwrap();
        assert_eq!(
            paths_from_pasteboard_content(
                vec![d1.clone()],
                Some(d2.to_string_lossy().into_owned())
            ),
            vec![d1],
            "text fallback is consulted only when no file paths decoded"
        );
    }

    #[test]
    fn text_fallback_used_when_no_urls() {
        let root = fixture_root("text-fallback");
        let d = root.join("dir");
        fs::create_dir(&d).unwrap();
        assert_eq!(
            paths_from_pasteboard_content(vec![], Some(format!("  {}  ", d.display()))),
            vec![d],
            "text path is trimmed and normalized"
        );
    }

    #[test]
    fn junk_text_and_empty_input_yield_nothing() {
        assert!(paths_from_pasteboard_content(vec![], None).is_empty());
        assert!(paths_from_pasteboard_content(vec![], Some("   ".into())).is_empty());
        assert!(
            paths_from_pasteboard_content(vec![], Some("/no/such/path/anywhere".into())).is_empty()
        );
    }
}
