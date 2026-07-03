// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! The multi-session registry (trmx-74, FR-2.1): id allocation + the collection of live
//! [`Session`]s a tab manager drives. Owns session STATE and LIFECYCLE only — the blocking
//! reader threads, transport channels, and event emission live in the shell (`termixion-tauri`),
//! fed by the [`PtyReader`] this registry hands out at spawn (once-only by construction).
//!
//! Id safety replaces the old single-slot generation counter: ids are **monotonic and never
//! reused** (checked allocation; `close` never frees an id), so a stale reader thread calling
//! [`SessionRegistry::close`] with its own id after that session is gone is an idempotent no-op
//! that can never touch another session.

use std::collections::HashMap;

use crate::pty::{PtyError, PtyFactory, PtyReader, PtySize, SessionSpec};
use crate::session::{Session, SessionId};

/// The collection of live sessions, keyed by monotonic never-reused [`SessionId`]s.
pub struct SessionRegistry {
    next_id: SessionId,
    sessions: HashMap<SessionId, Session>,
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionRegistry {
    /// An empty registry; the first session gets id `1`.
    pub fn new() -> Self {
        Self::with_first_id(1)
    }

    /// An empty registry whose first session gets `first_id` — public so the id-exhaustion edge
    /// is testable near `u64::MAX` without 2^64 spawns.
    pub fn with_first_id(first_id: SessionId) -> Self {
        Self {
            next_id: first_id,
            sessions: HashMap::new(),
        }
    }

    /// Spawn a session and hand back its id plus the blocking output reader (the caller moves the
    /// reader to a dedicated thread — ADR-0001). Fails without leaking a live child when the id
    /// space is exhausted, the spawn itself fails, or the backend exposes no separable reader.
    pub fn spawn(
        &mut self,
        factory: &dyn PtyFactory,
        spec: &SessionSpec,
        size: PtySize,
    ) -> Result<(SessionId, Box<dyn PtyReader>), PtyError> {
        let id = self.next_id;
        // Checked allocation: refuse (rather than wrap/reuse) at exhaustion, BEFORE spawning, so
        // nothing leaks. Ids are never reused after close — the registry's core safety invariant.
        let next = id
            .checked_add(1)
            .ok_or_else(|| PtyError::Io("session id space exhausted".into()))?;
        let mut session = Session::spawn(id, factory, spec, size)?;
        let Some(reader) = session.take_reader() else {
            // No separable reader: kill the just-spawned child so nothing leaks, then refuse
            // (today's shell-side guard, now registry-owned).
            let _ = session.kill();
            return Err(PtyError::Io(
                "pty backend exposes no readable stream".into(),
            ));
        };
        self.next_id = next;
        self.sessions.insert(id, session);
        Ok((id, reader))
    }

    /// Write user input to the session. Absent id → [`PtyError::NotFound`].
    pub fn write(&mut self, id: SessionId, data: &[u8]) -> Result<usize, PtyError> {
        self.sessions
            .get_mut(&id)
            .ok_or(PtyError::NotFound(id))?
            .write(data)
    }

    /// Resize the session's grid. Absent id → [`PtyError::NotFound`].
    pub fn resize(&mut self, id: SessionId, size: PtySize) -> Result<(), PtyError> {
        self.sessions
            .get_mut(&id)
            .ok_or(PtyError::NotFound(id))?
            .resize(size)
    }

    /// Remove and kill the session. **Idempotent**: an absent id (already closed, or a stale
    /// reader reaping after replacement) is `Ok(())` — closing can never touch another session
    /// because ids are never reused.
    pub fn close(&mut self, id: SessionId) -> Result<(), PtyError> {
        match self.sessions.remove(&id) {
            Some(mut session) => session.kill(),
            None => Ok(()),
        }
    }

    /// Kill and remove every session (window close). Best-effort per session.
    pub fn kill_all(&mut self) {
        for (_, mut session) in self.sessions.drain() {
            let _ = session.kill();
        }
    }

    /// Override the session's title (trmx-75, FR-2.4). The frontend is the **single core-title
    /// writer**: it mirrors each tab's EFFECTIVE title (manual > OSC > process > fallback,
    /// computed in the reducer) through the shell's `set_session_title` command into here. The
    /// foreground-name poller only *hints* and never calls this — so a process-name hint can
    /// never clobber a manual rename or an OSC title. Absent id → [`PtyError::NotFound`].
    pub fn set_title(&mut self, id: SessionId, title: impl Into<String>) -> Result<(), PtyError> {
        self.sessions
            .get_mut(&id)
            .ok_or(PtyError::NotFound(id))?
            .set_title(title);
        Ok(())
    }

    /// The session's current title, owned (trmx-75 — the mirror read-back for tests and the
    /// shell, without holding a borrow of the registry). Absent id → [`PtyError::NotFound`].
    pub fn title(&self, id: SessionId) -> Result<String, PtyError> {
        self.sessions
            .get(&id)
            .ok_or(PtyError::NotFound(id))
            .map(|session| session.title().to_string())
    }

    /// The child's OS pid, if the backend exposes one. Absent id → [`PtyError::NotFound`].
    /// (Consumed by the platform golden tests' no-zombie assertions and, since trmx-75, by the
    /// shell's foreground-name poller; later by FR-7a.)
    pub fn process_id(&self, id: SessionId) -> Result<Option<u32>, PtyError> {
        self.sessions
            .get(&id)
            .ok_or(PtyError::NotFound(id))
            .map(Session::process_id)
    }

    /// Live session ids, ascending.
    pub fn ids(&self) -> Vec<SessionId> {
        let mut ids: Vec<SessionId> = self.sessions.keys().copied().collect();
        ids.sort_unstable();
        ids
    }

    /// Number of live sessions.
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    /// Whether the registry holds no live sessions.
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{FakePtyFactory, SeparableFakePtyFactory};

    fn spec() -> SessionSpec {
        SessionSpec::shell("/bin/sh")
    }

    #[test]
    fn spawn_returns_monotonic_ids_and_usable_readers() {
        let factory = SeparableFakePtyFactory;
        let mut reg = SessionRegistry::new();
        let (id1, mut r1) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn 1");
        let (id2, mut r2) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn 2");
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert!(id2 > id1, "ids strictly increase");

        // Writes route to the RIGHT session: each reader sees only its own echo.
        reg.write(id1, b"one").expect("write 1");
        reg.write(id2, b"two").expect("write 2");
        let mut buf = [0u8; 8];
        assert_eq!(r1.read(&mut buf).expect("read 1"), 3);
        assert_eq!(&buf[..3], b"one");
        assert_eq!(r2.read(&mut buf).expect("read 2"), 3);
        assert_eq!(&buf[..3], b"two");
        assert_eq!(reg.ids(), vec![id1, id2]);
    }

    #[test]
    fn ids_are_never_reused_and_stale_close_cannot_touch_a_newer_session() {
        let factory = SeparableFakePtyFactory;
        let mut reg = SessionRegistry::new();
        let (id1, _r1) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn 1");
        reg.close(id1).expect("close 1");
        let (id2, mut r2) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn 2");
        assert!(id2 > id1, "a closed id is never reused");

        // A stale reaper closing id1 AGAIN is an idempotent no-op...
        reg.close(id1).expect("stale close is Ok");
        // ...and the newer session is untouched: still writable, still echoing.
        reg.write(id2, b"alive").expect("write 2");
        let mut buf = [0u8; 8];
        assert_eq!(r2.read(&mut buf).expect("read 2"), 5);
        assert_eq!(&buf[..5], b"alive");
    }

    #[test]
    fn id_space_exhaustion_refuses_cleanly_before_spawning() {
        let factory = SeparableFakePtyFactory;
        // Pinned semantic: with next_id == u64::MAX the checked advance fails BEFORE any spawn,
        // so the id u64::MAX itself is never issued and nothing leaks.
        let mut reg = SessionRegistry::with_first_id(u64::MAX);
        let Err(err) = reg.spawn(&factory, &spec(), PtySize::default()) else {
            panic!("exhaustion must refuse");
        };
        assert!(matches!(err, PtyError::Io(_)));
        assert!(reg.is_empty(), "nothing spawned, nothing leaked");

        // One id below the ceiling still works (u64::MAX - 1 is the last usable id)...
        let mut reg = SessionRegistry::with_first_id(u64::MAX - 1);
        let (id, _reader) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("last id");
        assert_eq!(id, u64::MAX - 1);
        // ...and the NEXT spawn hits the ceiling.
        assert!(reg.spawn(&factory, &spec(), PtySize::default()).is_err());
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn write_and_resize_report_not_found_for_absent_ids() {
        let mut reg = SessionRegistry::new();
        assert!(matches!(reg.write(9, b"x"), Err(PtyError::NotFound(9))));
        assert!(matches!(
            reg.resize(9, PtySize::default()),
            Err(PtyError::NotFound(9))
        ));
        assert!(matches!(reg.process_id(9), Err(PtyError::NotFound(9))));
    }

    #[test]
    fn close_kills_and_is_idempotent() {
        let factory = SeparableFakePtyFactory;
        let mut reg = SessionRegistry::new();
        let (id, mut reader) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn");
        reg.close(id).expect("close");
        // The reader observes EOF (killed + drained).
        let mut buf = [0u8; 4];
        assert_eq!(reader.read(&mut buf).expect("eof"), 0);
        // Absent now: writes refuse, close is a no-op.
        assert!(matches!(reg.write(id, b"x"), Err(PtyError::NotFound(_))));
        reg.close(id).expect("idempotent close");
        assert!(reg.is_empty());
    }

    #[test]
    fn kill_all_empties_the_registry_and_ends_every_reader() {
        let factory = SeparableFakePtyFactory;
        let mut reg = SessionRegistry::new();
        let (_, mut r1) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn 1");
        let (_, mut r2) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn 2");
        reg.kill_all();
        assert!(reg.is_empty());
        let mut buf = [0u8; 4];
        assert_eq!(r1.read(&mut buf).expect("r1 eof"), 0);
        assert_eq!(r2.read(&mut buf).expect("r2 eof"), 0);
    }

    #[test]
    fn no_reader_backend_refuses_spawn_without_leaking_a_live_session() {
        // The plain fake exposes no separable reader — spawn must kill the child and refuse.
        let factory = FakePtyFactory;
        let mut reg = SessionRegistry::new();
        let Err(err) = reg.spawn(&factory, &spec(), PtySize::default()) else {
            panic!("no reader → refuse");
        };
        assert!(matches!(err, PtyError::Io(_)));
        assert!(
            reg.is_empty(),
            "the readerless session must not be retained"
        );
        // next_id commits only on success — a failed spawn does not burn an id.
        let factory = SeparableFakePtyFactory;
        let (id, _r) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn");
        assert_eq!(id, 1, "a failed spawn does not burn an id");
    }

    #[test]
    fn process_id_is_none_for_fake_backends_but_some_shape_is_reachable() {
        let factory = SeparableFakePtyFactory;
        let mut reg = SessionRegistry::new();
        let (id, _r) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn");
        // Fakes have no real child; the registry surfaces the backend's answer verbatim.
        assert_eq!(reg.process_id(id).expect("live id"), None);
    }

    #[test]
    fn set_title_round_trips_through_the_registry() {
        // trmx-75 (FR-2.4): the frontend mirrors each tab's EFFECTIVE title into the core via
        // set_title; title() reads it back. Spawn seeds the title from the spec's program (the
        // Session contract), then the override must round-trip verbatim.
        let factory = SeparableFakePtyFactory;
        let mut reg = SessionRegistry::new();
        let (id, _r) = reg
            .spawn(&factory, &spec(), PtySize::default())
            .expect("spawn");
        assert_eq!(reg.title(id).expect("live id"), "/bin/sh");
        reg.set_title(id, "vim — main.rs").expect("set_title");
        assert_eq!(reg.title(id).expect("live id"), "vim — main.rs");
    }

    #[test]
    fn set_title_and_title_report_not_found_for_absent_ids() {
        // trmx-75: sibling-shaped with write/resize/process_id — an id the registry has never
        // seen (or already removed) refuses with NotFound rather than silently ignoring.
        let mut reg = SessionRegistry::new();
        assert!(matches!(reg.set_title(9, "x"), Err(PtyError::NotFound(9))));
        assert!(matches!(reg.title(9), Err(PtyError::NotFound(9))));
    }
}
