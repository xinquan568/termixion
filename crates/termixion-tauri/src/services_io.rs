// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-224: the pending service-open-paths queue — the shell half of the macOS Services
//! "New Termixion Tab Here" delivery.
//!
//! The platform provider (termixion-platform `services`) decodes a Finder service
//! invocation into directories and hands them to the `setup()` callback, which calls
//! [`enqueue`] and then [`nudge`]. The split is deliberate and load-bearing: paths are
//! **visible in the queue before any event is emitted**, so the frontend's atomic
//! [`take_pending_open_paths`] can never observe a nudge whose paths aren't there yet,
//! and a nudge lost before the webview's listener registered is recovered by the boot /
//! registration-completion drains reading the queue directly. The queue is the single
//! backend source of truth; the nudge is only a wake-up.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Runtime, State};

/// The payload-less wake-up event the frontend listens for.
pub const OPEN_PATHS_EVENT: &str = "services:open-paths";

/// Managed state: directories awaiting frontend pickup, in service-invocation order.
#[derive(Default)]
pub struct PendingOpenPaths(Mutex<Vec<String>>);

/// Append `paths` to the queue. Visible to [`take`] immediately — callers emit the nudge
/// strictly afterwards (see module docs). A poisoned lock (a panic while held — none of
/// the holders can panic) degrades to dropping the batch rather than propagating.
pub fn enqueue(state: &PendingOpenPaths, paths: Vec<String>) {
    if let Ok(mut queue) = state.0.lock() {
        queue.extend(paths);
    }
}

/// Emit the payload-less wake-up. Failure is benign (no webview yet — the boot drain
/// reads the queue anyway), so the result is deliberately dropped.
pub fn nudge<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(OPEN_PATHS_EVENT, ());
}

/// Atomically drain the queue: returns everything enqueued so far and leaves it empty.
pub fn take(state: &PendingOpenPaths) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut queue| std::mem::take(&mut *queue))
        .unwrap_or_default()
}

/// The frontend's drain command (boot and nudge-triggered drains both land here).
#[tauri::command]
pub fn take_pending_open_paths(state: State<'_, PendingOpenPaths>) -> Vec<String> {
    take(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_is_visible_to_take_without_any_nudge() {
        // The structural enqueue/nudge split: no AppHandle, no event — the queue alone
        // carries the paths (the frontend's recovery drains depend on exactly this).
        let state = PendingOpenPaths::default();
        enqueue(&state, vec!["/a".into(), "/b".into()]);
        assert_eq!(take(&state), vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn take_empties_the_queue_and_second_take_is_empty() {
        let state = PendingOpenPaths::default();
        enqueue(&state, vec!["/a".into()]);
        assert_eq!(take(&state), vec!["/a".to_string()]);
        assert!(
            take(&state).is_empty(),
            "atomic drain: second take sees nothing"
        );
    }

    #[test]
    fn enqueue_after_take_starts_a_fresh_batch_in_order() {
        let state = PendingOpenPaths::default();
        enqueue(&state, vec!["/a".into()]);
        let _ = take(&state);
        enqueue(&state, vec!["/b".into()]);
        enqueue(&state, vec!["/c".into()]);
        assert_eq!(take(&state), vec!["/b".to_string(), "/c".to_string()]);
    }

    #[test]
    fn concurrent_enqueues_all_land() {
        use std::sync::Arc;
        let state = Arc::new(PendingOpenPaths::default());
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let state = Arc::clone(&state);
                std::thread::spawn(move || enqueue(&state, vec![format!("/dir-{i}")]))
            })
            .collect();
        for h in handles {
            h.join().expect("enqueue thread");
        }
        let mut got = take(&state);
        got.sort();
        let want: Vec<String> = (0..8).map(|i| format!("/dir-{i}")).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn info_plist_declares_the_services_entry() {
        // T4 (trmx-224): the authored Info.plist next to tauri.conf.json — tauri-bundler
        // merges it into the bundle. The kitty-verified NSServices shape, exactly.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/Info.plist");
        let value = plist::Value::from_file(path).expect("Info.plist parses");
        let services = value
            .as_dictionary()
            .and_then(|d| d.get("NSServices"))
            .and_then(|v| v.as_array())
            .expect("NSServices array");
        assert_eq!(services.len(), 1, "exactly one service entry");
        let entry = services[0].as_dictionary().expect("entry dict");
        let menu_item = entry
            .get("NSMenuItem")
            .and_then(|v| v.as_dictionary())
            .expect("NSMenuItem is a DICTIONARY (sole key `default`)");
        assert_eq!(
            menu_item.get("default").and_then(|v| v.as_string()),
            Some("New Termixion Tab Here")
        );
        assert_eq!(
            entry.get("NSMessage").and_then(|v| v.as_string()),
            Some("openTab"),
            "NSMessage names the provider selector prefix"
        );
        let ctx = entry
            .get("NSRequiredContext")
            .and_then(|v| v.as_dictionary())
            .expect("NSRequiredContext dict");
        assert_eq!(
            ctx.get("NSTextContent").and_then(|v| v.as_string()),
            Some("FilePath")
        );
        let send: Vec<&str> = entry
            .get("NSSendTypes")
            .and_then(|v| v.as_array())
            .expect("NSSendTypes array")
            .iter()
            .filter_map(|v| v.as_string())
            .collect();
        assert_eq!(send, vec!["NSFilenamesPboardType", "public.plain-text"]);
    }
}
