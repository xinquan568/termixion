// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252 (L13): the census that keeps the command ACL honest.
//
// Declaring `AppManifest::commands` flips every app command from "reachable from any webview" to
// "reachable only where a capability grants it" (tauri-2.11.5 `webview/mod.rs:1820` — the ACL is
// enforced for app commands exactly when `has_app_manifest()` is true). That makes an OMISSION an
// availability regression: forget a command in the manifest or in a capability file and it is
// denied at runtime, in front of a user, not at build time.
//
// So no list here is transcribed by hand from another list. The registered set is parsed out of
// `main.rs`'s `tauri::generate_handler![…]`, the manifest set out of `build.rs`'s
// `AppManifest::commands(&[…])`, and the granted sets out of the capability JSON — with `syn`
// rather than string matching, because the trmx-300 census learned twice over what a text
// heuristic does to Rust source.

use std::collections::BTreeSet;

use syn::punctuated::Punctuated;
use syn::visit::Visit;

const MAIN_RS: &str = include_str!("../src/main.rs");
const BUILD_RS: &str = include_str!("../build.rs");
const LAUNCH_RS: &str = include_str!("../src/launch.rs");
const DEFAULT_CAPABILITY: &str = include_str!("../capabilities/default.json");
const MAIN_WINDOW_CAPABILITY: &str = include_str!("../capabilities/main-window.json");

const CONFIG_IO_RS: &str = include_str!("../src/config_io.rs");

/// trmx-246 (grill L5): the `keys_read` command serves the CACHE, never the file — its body is
/// exactly the one call `keys_from_state(&state)`. A hermetic runtime test of a Tauri command
/// needs the `test` feature; the census already parses real signatures, so the same AST walk
/// pins the body: a mutant that re-reads the filesystem inside the command fails here.
#[test]
fn keys_read_is_pure_delegation() {
    let file = syn::parse_file(CONFIG_IO_RS).expect("config_io.rs parses");
    let function = file
        .items
        .iter()
        .find_map(|item| match item {
            syn::Item::Fn(f) if f.sig.ident == "keys_read" => Some(f),
            _ => None,
        })
        .expect("a top-level fn keys_read");
    assert!(
        function.attrs.iter().any(|a| a
            .path()
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect::<Vec<_>>()
            == ["tauri", "command"]),
        "keys_read is a #[tauri::command]"
    );
    assert_eq!(
        function.sig.inputs.len(),
        1,
        "keys_read takes exactly the managed state"
    );
    assert_eq!(
        function.block.stmts.len(),
        1,
        "keys_read's body is one expression"
    );
    let syn::Stmt::Expr(syn::Expr::Call(call), None) = &function.block.stmts[0] else {
        panic!("keys_read's body must be a single call expression");
    };
    let syn::Expr::Path(callee) = &*call.func else {
        panic!("the call must name a function");
    };
    assert!(
        callee.path.is_ident("keys_from_state"),
        "the call must be keys_from_state"
    );
    assert_eq!(call.args.len(), 1);
    let syn::Expr::Reference(arg) = &call.args[0] else {
        panic!("the argument must be `&state`");
    };
    let syn::Expr::Path(state) = &*arg.expr else {
        panic!("the argument must be `&state`");
    };
    assert!(state.path.is_ident("state"));
}

/// The commands only the PTY-owning main window may invoke, named rather than merely counted.
///
/// Naming them is the point: a "each command appears in exactly one file" check would pass while a
/// newly added command drifted into the permissive bucket, which is the failure this classification
/// exists to prevent. Adding a command therefore has to touch this list, and the decision is made
/// once, here, in review.
///
/// The three the issue's own sketch under-classified, with the justification each time already in
/// the source: `webview_close_request` / `close_acknowledged` (`close_gate.rs` — PTY-owner only,
/// like `quit_confirmed`) and `take_pending_open_paths` (the main-window-only invariant exists in
/// `app/src/main.tsx`, but as frontend self-restraint — the Rust command has no window check).
const MAIN_ONLY: [&str; 14] = [
    "open_pty",
    "pty_write",
    "pty_ack",
    "pty_resize",
    "close_pty",
    "control_response",
    "quit_confirmed",
    "webview_close_request",
    "close_acknowledged",
    "take_pending_open_paths",
    "smoke_config",
    "smoke_done",
    "perf_config",
    "perf_done",
];

/// The commands both windows may invoke: config, themes, scripts, shells, logging, the settings
/// window itself. The settings window genuinely needs these — it is a second webview onto the same
/// configuration — so `default.json` (windows: main + settings) is where they belong.
const SHARED: [&str; 19] = [
    "core_version",
    "config_read",
    "config_write",
    "config_reset_all",
    "config_open_file",
    "keys_read",
    "shells_list",
    "effective_shell",
    "open_settings_window",
    "themes_read",
    "themes_write",
    "themes_open_dir",
    "scripts_list",
    "scripts_open_dir",
    "shell_integration_reveal",
    "log_message",
    "log_dir",
    "log_open_dir",
    "enhancements_status",
];

/// Every command registered with the Tauri builder, read from `tauri::generate_handler![…]`.
///
/// The macro body is a comma-separated path list (`config_io::config_read`), so it parses as
/// `Punctuated<Path, Comma>` and the command name is the LAST segment — the same name the ACL and
/// the frontend's `invoke` use.
#[derive(Default)]
struct RegisteredCommands(Option<Vec<String>>);

impl<'ast> Visit<'ast> for RegisteredCommands {
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        if mac
            .path
            .segments
            .last()
            .is_some_and(|segment| segment.ident == "generate_handler")
        {
            let paths = mac
                .parse_body_with(Punctuated::<syn::Path, syn::Token![,]>::parse_terminated)
                .expect("generate_handler! holds a comma-separated path list");
            let names = paths
                .iter()
                .map(|path| {
                    path.segments
                        .last()
                        .expect("a command path has at least one segment")
                        .ident
                        .to_string()
                })
                .collect();
            assert!(
                self.0.replace(names).is_none(),
                "main.rs invokes generate_handler! more than once — the census reads one list"
            );
        }
        syn::visit::visit_macro(self, mac);
    }
}

/// The command list handed to `AppManifest::commands(…)` in `build.rs`, whether written inline as
/// `&[…]` or (as it is) held in a documented `const` in the same file.
struct ManifestCommands<'ast> {
    file: &'ast syn::File,
    found: Option<Vec<String>>,
}

impl<'ast> Visit<'ast> for ManifestCommands<'ast> {
    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        if call.method == "commands" {
            let argument = call
                .args
                .first()
                .expect("AppManifest::commands takes one argument");
            let names = string_slice_literal(argument, self.file);
            assert!(
                self.found.replace(names).is_none(),
                "build.rs calls .commands(..) more than once — the census reads one list"
            );
        }
        syn::visit::visit_expr_method_call(self, call);
    }
}

/// Read a `&["a", "b"]` slice literal, following ONE level of `const NAME: &[&str] = &[…];`
/// indirection within the same file. Anything else (a `concat!`, a value built at runtime, a
/// const from another module) is rejected loudly: the census is only a gate for as long as the
/// list is readable from source.
fn string_slice_literal(expr: &syn::Expr, file: &syn::File) -> Vec<String> {
    const SHAPE: &str = "AppManifest::commands must be given a `&[…]` literal, or a const in the \
                         same file holding one, so the census can read it";
    let expr = match expr {
        syn::Expr::Path(path) => {
            let name = path
                .path
                .get_ident()
                .unwrap_or_else(|| panic!("{SHAPE}"))
                .to_string();
            file.items
                .iter()
                .find_map(|item| match item {
                    syn::Item::Const(item) if item.ident == name => Some(item.expr.as_ref()),
                    _ => None,
                })
                .unwrap_or_else(|| panic!("{SHAPE} — no `const {name}` in build.rs"))
        }
        other => other,
    };
    let syn::Expr::Reference(reference) = expr else {
        panic!("{SHAPE}");
    };
    let syn::Expr::Array(array) = reference.expr.as_ref() else {
        panic!("{SHAPE}");
    };
    array
        .elems
        .iter()
        .map(|element| match element {
            syn::Expr::Lit(syn::ExprLit {
                lit: syn::Lit::Str(name),
                ..
            }) => name.value(),
            _ => panic!("every AppManifest::commands entry must be a string literal"),
        })
        .collect()
}

/// A `Vec` → `BTreeSet` that refuses to swallow a duplicate: two identical entries would otherwise
/// make a set comparison pass while a count comparison fails, for reasons no one could see.
fn unique(names: Vec<String>, what: &str) -> BTreeSet<String> {
    let set: BTreeSet<String> = names.iter().cloned().collect();
    assert_eq!(
        set.len(),
        names.len(),
        "{what} lists a command twice: {names:?}"
    );
    set
}

fn registered_commands() -> BTreeSet<String> {
    let file = syn::parse_file(MAIN_RS).expect("main.rs parses");
    let mut visitor = RegisteredCommands::default();
    visitor.visit_file(&file);
    let names = visitor
        .0
        .expect("main.rs registers its commands with tauri::generate_handler![…]");
    unique(names, "the generate_handler! list")
}

fn manifest_commands() -> BTreeSet<String> {
    let file = syn::parse_file(BUILD_RS).expect("build.rs parses");
    let mut visitor = ManifestCommands {
        file: &file,
        found: None,
    };
    visitor.visit_file(&file);
    let names = visitor.found.expect(
        "build.rs must declare the app manifest — tauri_build::AppManifest::new().commands(&[…]) \
         — or every app command stays reachable from any webview",
    );
    unique(names, "the AppManifest::commands list")
}

fn named(list: &[&str], what: &str) -> BTreeSet<String> {
    unique(list.iter().map(|name| (*name).to_string()).collect(), what)
}

fn capability(json: &str, name: &str) -> serde_json::Value {
    serde_json::from_str(json).unwrap_or_else(|err| panic!("{name} is valid JSON: {err}"))
}

fn windows_of(capability: &serde_json::Value, name: &str) -> Vec<String> {
    capability["windows"]
        .as_array()
        .unwrap_or_else(|| panic!("{name} declares the windows it applies to"))
        .iter()
        .map(|label| {
            label
                .as_str()
                .unwrap_or_else(|| panic!("{name} window labels are strings"))
                .to_string()
        })
        .collect()
}

/// The app-command grants in one capability file: `"allow-open-pty"` → `open_pty`.
///
/// A prefixed identifier (`core:default`, `updater:allow-check`) addresses a plugin's ACL, never
/// the app's — `APP_ACL_KEY` is what an unprefixed one resolves to (`tauri-utils` `resolved.rs`).
/// Anything unprefixed that is not an `allow-<command>` grant for a REGISTERED command is a hard
/// failure: a typo there is a runtime denial in front of a user, and the build says nothing.
fn granted_commands(
    capability: &serde_json::Value,
    name: &str,
    registered: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut granted = BTreeSet::new();
    for permission in capability["permissions"]
        .as_array()
        .unwrap_or_else(|| panic!("{name} lists permissions"))
    {
        let identifier = permission
            .as_str()
            .unwrap_or_else(|| panic!("{name} permission entries are strings"));
        if identifier.contains(':') {
            continue;
        }
        let Some(slug) = identifier.strip_prefix("allow-") else {
            panic!(
                "{name} carries the unprefixed permission {identifier:?}, which is neither a \
                 plugin grant nor an app `allow-<command>` grant"
            );
        };
        let command = slug.replace('-', "_");
        assert!(
            registered.contains(&command),
            "{name} grants {identifier:?}, but no command named {command:?} is registered"
        );
        assert!(
            granted.insert(command),
            "{name} grants {identifier:?} twice"
        );
    }
    granted
}

/// The classification, asserted by NAME in both directions and proven exhaustive.
///
/// An ungranted command is not a smaller attack surface, it is a broken feature: the ACL denies it
/// at runtime with nothing having failed at build time. So the union must be the whole registered
/// set, and the two buckets must not overlap.
#[test]
fn every_command_is_granted_to_exactly_one_window_set() {
    let registered = registered_commands();
    let default = capability(DEFAULT_CAPABILITY, "default.json");
    let main_window = capability(MAIN_WINDOW_CAPABILITY, "main-window.json");

    // "main-only" means nothing unless the files still carry these window lists.
    assert_eq!(
        windows_of(&default, "default.json"),
        ["main", "settings"],
        "default.json is the SHARED capability — both windows"
    );
    assert_eq!(
        windows_of(&main_window, "main-window.json"),
        ["main"],
        "main-window.json is what makes a grant main-only"
    );

    let shared = granted_commands(&default, "default.json", &registered);
    let main_only = granted_commands(&main_window, "main-window.json", &registered);

    assert_eq!(
        main_only,
        named(&MAIN_ONLY, "MAIN_ONLY"),
        "the set of main-window-only commands drifted from the 14 classified in review"
    );
    assert_eq!(
        shared,
        named(&SHARED, "SHARED"),
        "the set of commands both windows may invoke drifted from the 19 classified in review"
    );

    let both: Vec<&String> = main_only.intersection(&shared).collect();
    assert!(
        both.is_empty(),
        "granted in both capabilities, so the main-only scoping buys nothing: {both:?}"
    );
    let granted: BTreeSet<String> = main_only.union(&shared).cloned().collect();
    assert_eq!(
        granted, registered,
        "every registered command must be granted somewhere — an ungranted one is denied at \
         runtime, in front of a user, with the build staying green"
    );
}

/// Drift in EITHER direction fails. A command registered but not in the manifest is a hole in the
/// ACL (nothing scopes it); a command in the manifest but not registered is a permission granted
/// for something that does not exist, which reads as coverage and is not.
#[test]
fn the_app_manifest_lists_exactly_the_registered_commands() {
    let registered = registered_commands();
    let manifest = manifest_commands();

    assert_eq!(
        manifest, registered,
        "build.rs's AppManifest::commands and main.rs's generate_handler! list have drifted"
    );
}

/// Does `function` take a `State<'_, SpecialLaunch>`? Matched structurally rather than on the
/// rendered type text, so a re-import (`tauri::State<'_, SpecialLaunch>`) still counts.
fn takes_special_launch_state(function: &syn::ItemFn) -> bool {
    function.sig.inputs.iter().any(|argument| {
        let syn::FnArg::Typed(typed) = argument else {
            return false;
        };
        let syn::Type::Path(path) = typed.ty.as_ref() else {
            return false;
        };
        let Some(segment) = path.path.segments.last() else {
            return false;
        };
        if segment.ident != "State" {
            return false;
        }
        let syn::PathArguments::AngleBracketed(arguments) = &segment.arguments else {
            return false;
        };
        arguments.args.iter().any(|argument| {
            matches!(
                argument,
                syn::GenericArgument::Type(syn::Type::Path(path))
                    if path.path.segments.last().is_some_and(|s| s.ident == "SpecialLaunch")
            )
        })
    })
}

/// Whether a body calls `exit_decision(..)`.
#[derive(Default)]
struct CallsExitDecision(bool);

impl<'ast> Visit<'ast> for CallsExitDecision {
    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let syn::Expr::Path(path) = call.func.as_ref()
            && path
                .path
                .segments
                .last()
                .is_some_and(|segment| segment.ident == "exit_decision")
        {
            self.0 = true;
        }
        syn::visit::visit_expr_call(self, call);
    }
}

/// trmx-252 (L13): `smoke_done` and `perf_done` end the process. Structurally, each must be able
/// to see its launch mode and must route the decision through `exit_decision`.
///
/// This is the half a unit test cannot reach: the semantics of the gate are pinned in launch.rs's
/// own tests, but nothing there stops a later edit from calling `std::process::exit` before
/// consulting it (constructing a real `State` needs a Tauri runtime — MockRuntime is #245, open
/// and unstarted). So the wiring is asserted from the source instead.
#[test]
fn the_exit_commands_consult_their_launch_mode() {
    let file = syn::parse_file(LAUNCH_RS).expect("launch.rs parses");
    for name in ["smoke_done", "perf_done"] {
        let function = file
            .items
            .iter()
            .find_map(|item| match item {
                syn::Item::Fn(function) if function.sig.ident == name => Some(function),
                _ => None,
            })
            .unwrap_or_else(|| panic!("launch.rs defines {name}"));
        assert!(
            takes_special_launch_state(function),
            "{name} exits the process, so it must take State<'_, SpecialLaunch> — without it the \
             command cannot tell a driven launch from any webview that felt like calling it"
        );
        let mut visitor = CallsExitDecision::default();
        visitor.visit_item_fn(function);
        assert!(
            visitor.0,
            "{name} must route through exit_decision(..) — the gate is only real if it is on the \
             path to std::process::exit"
        );
    }
}
