use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use super::{lock_mutex, LogManager};

struct TestRoot(PathBuf);
impl TestRoot {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("hypercom_migration_{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn manager(&self, mode: &str) -> (LogManager, PathBuf) {
        let old = self.0.join("active");
        fs::create_dir_all(&old).unwrap();
        let manager = LogManager::for_test(&old);
        manager.test_settings(|settings| {
            settings.subdir_mode = mode.into();
            settings.filename_format = "[com]".into();
            settings.include_timestamp = false;
            settings.include_direction = false;
        });
        (manager, old)
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn force_copy(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::other("forced cross-volume fallback"))
}
fn open(manager: &LogManager, port: &str) {
    manager
        .create_writer_with_encoding(port, "string", "UTF-8")
        .unwrap();
}

#[test]
fn active_buffers_and_rx_assembly_survive_every_layout_and_copy_fallback() {
    for mode in ["none", "date", "port"] {
        for copy_only in [false, true] {
            let temp = TestRoot::new();
            let (manager, old) = temp.manager(mode);
            open(&manager, "COM3");
            let source = manager.writer_path("COM3").unwrap();
            manager.write("COM3", "t", "TX", b"TX-BEFORE").unwrap();
            manager
                .write_rx("COM3", "t", b"RX-COMPLETE\ntail-")
                .unwrap();
            assert_eq!(
                fs::metadata(&source).unwrap().len(),
                0,
                "the regression must contain unflushed data"
            );
            let new = temp.0.join("destination");
            let moved = if copy_only {
                manager.migrate_directory_with(&old, &new, force_copy)
            } else {
                manager.migrate_directory(&old, &new)
            }
            .unwrap();
            assert_eq!(moved, 1, "{mode}, copy={copy_only}");
            let expected_path = new.join(source.strip_prefix(&old).unwrap());
            assert_eq!(manager.writer_path("COM3").unwrap(), expected_path);
            assert!(!source.exists());
            manager.write_rx("COM3", "t", b"end\n").unwrap();
            manager.write("COM3", "t", "TX", b"TX-AFTER").unwrap();
            let export = temp.0.join("export.txt");
            manager
                .save_log_as("COM3", export.to_str().unwrap())
                .unwrap();
            assert_eq!(
                fs::read_to_string(&export).unwrap(),
                "TX-BEFORE\nRX-COMPLETE\ntail-end\nTX-AFTER\n"
            );
            manager.close_all().unwrap();
        }
    }
}

#[test]
fn parent_migration_rebinds_exact_path_and_preserves_custom_attribution_after_close() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("port");
    manager.test_settings(|settings| settings.filename_format = "log_[com]_custom".into());
    open(&manager, "COM3");
    let source = manager.writer_path("COM3").unwrap();
    manager.write("COM3", "t", "TX", b"before").unwrap();
    assert_eq!(
        manager
            .migrate_directory_with(&old, &temp.0, force_copy)
            .unwrap(),
        1
    );
    let target = temp.0.join(source.strip_prefix(&old).unwrap());
    assert_eq!(manager.writer_path("COM3").unwrap(), target);
    manager.write("COM3", "t", "TX", b"after").unwrap();
    let export = temp.0.join("export.txt");
    manager
        .save_log_as("COM3", export.to_str().unwrap())
        .unwrap();
    assert_eq!(fs::read_to_string(&export).unwrap(), "before\nafter\n");
    manager.close_writer("COM3").unwrap();
    manager
        .save_log_as("COM3", export.to_str().unwrap())
        .unwrap();
    assert_eq!(fs::read_to_string(&export).unwrap(), "before\nafter\n");
    assert_eq!(
        manager
            .list_files()
            .unwrap()
            .iter()
            .find(|entry| Path::new(&entry.path) == target)
            .unwrap()
            .port_id,
        "COM3"
    );
}

#[test]
fn child_destination_retains_existing_subtree_and_same_root_is_a_noop() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    let new = old.join("archive");
    fs::create_dir(&new).unwrap();
    fs::write(new.join("existing.log"), b"keep").unwrap();
    fs::write(old.join("notes.txt"), b"non-log").unwrap();
    open(&manager, "COM3");
    manager.write("COM3", "t", "TX", b"before").unwrap();
    assert_eq!(manager.migrate_directory(&old, &new).unwrap(), 1);
    let path = manager.writer_path("COM3").unwrap();
    assert_eq!(fs::read(new.join("existing.log")).unwrap(), b"keep");
    assert!(!new.join("archive").exists());
    assert_eq!(manager.migrate_directory(&new, &new.join(".")).unwrap(), 0);
    assert_eq!(manager.writer_path("COM3").unwrap(), path);
    assert!(old.join("notes.txt").exists());
    manager.close_all().unwrap();
}

#[test]
fn only_the_current_root_can_be_migrated() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    let other = temp.0.join("unrelated");
    fs::create_dir(&other).unwrap();
    assert!(manager
        .migrate_directory(&other, &temp.0.join("new"))
        .is_err());
    assert!(manager
        .migrate_directory(&old.join("missing"), &other)
        .is_err());
    assert_eq!(manager.get_directory(), old);
}

#[test]
fn active_destination_collision_preserves_both_files_and_old_owner() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    open(&manager, "COM3");
    manager.write("COM3", "t", "TX", b"before").unwrap();
    let source = manager.writer_path("COM3").unwrap();
    let new = temp.0.join("new");
    fs::create_dir(&new).unwrap();
    fs::write(new.join("COM3.log"), b"unrelated").unwrap();
    assert!(manager
        .migrate_directory_with(&old, &new, force_copy)
        .is_err());
    assert_eq!(manager.get_directory(), old);
    assert_eq!(manager.writer_path("COM3").unwrap(), source);
    assert_eq!(fs::read(new.join("COM3.log")).unwrap(), b"unrelated");
    manager.write("COM3", "t", "TX", b"after").unwrap();
    manager.close_all().unwrap();
    assert_eq!(fs::read_to_string(source).unwrap(), "before\nafter\n");
}

#[test]
fn later_prepare_failure_cleans_only_owned_targets_without_publishing_any_writer() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("port");
    for id in ["A", "Z"] {
        open(&manager, id);
        manager.write(id, "t", "TX", id.as_bytes()).unwrap();
    }
    let original = manager.writer_path("A").unwrap();
    let new = temp.0.join("new");
    fs::create_dir(&new).unwrap();
    fs::write(new.join("Z"), b"not a directory").unwrap();
    assert!(manager
        .migrate_directory_with(&old, &new, force_copy)
        .is_err());
    assert_eq!(manager.get_directory(), old);
    assert_eq!(manager.writer_path("A").unwrap(), original);
    assert!(!new.join("A/A.log").exists());
    assert_eq!(fs::read(new.join("Z")).unwrap(), b"not a directory");
    manager.write("A", "t", "TX", b"after").unwrap();
    manager.close_all().unwrap();
    assert_eq!(fs::read_to_string(original).unwrap(), "A\nafter\n");
}

#[test]
fn historical_collision_is_skipped_without_overwriting_or_losing_the_source() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    let new = temp.0.join("new");
    fs::create_dir(&new).unwrap();
    fs::write(old.join("history.log"), b"source").unwrap();
    fs::write(new.join("history.log"), b"target").unwrap();
    assert_eq!(
        manager
            .migrate_directory_with(&old, &new, force_copy)
            .unwrap(),
        0
    );
    assert_eq!(manager.get_directory(), new);
    assert_eq!(fs::read(old.join("history.log")).unwrap(), b"source");
    assert_eq!(fs::read(new.join("history.log")).unwrap(), b"target");
}

#[test]
fn shared_append_path_is_copied_once_and_both_writers_keep_append_semantics() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    manager.test_settings(|settings| settings.filename_format = "shared".into());
    for (id, text) in [("COM1", b"one".as_slice()), ("COM2", b"two".as_slice())] {
        open(&manager, id);
        manager.write(id, "t", "TX", text).unwrap();
    }
    let new = temp.0.join("new");
    assert_eq!(
        manager
            .migrate_directory_with(&old, &new, force_copy)
            .unwrap(),
        1
    );
    manager.write("COM1", "t", "TX", b"three").unwrap();
    manager.write("COM2", "t", "TX", b"four").unwrap();
    manager.close_all().unwrap();
    let content = fs::read_to_string(new.join("shared.log")).unwrap();
    for line in ["one", "two", "three", "four"] {
        assert_eq!(content.lines().filter(|actual| *actual == line).count(), 1);
    }
}

#[test]
fn half_characters_and_locked_encoding_survive_migration() {
    for (encoding, first, rest) in [
        ("UTF-8", vec![0xe4, 0xb8], vec![0xad, b'\n']),
        ("GBK", vec![0xd6], vec![0xd0, b'\n']),
    ] {
        let temp = TestRoot::new();
        let (manager, old) = temp.manager("port");
        manager
            .create_writer_with_encoding("COM3", "string", encoding)
            .unwrap();
        manager.write_rx("COM3", "t", &first).unwrap();
        manager.test_settings(|settings| {
            settings.encoding = "UTF-8".into();
            settings.include_direction = true;
            settings.new_file_per_session = true;
        });
        let new = temp.0.join("new");
        assert_eq!(
            manager
                .migrate_directory_with(&old, &new, force_copy)
                .unwrap(),
            1
        );
        manager.write_rx("COM3", "t", &rest).unwrap();
        manager.close_writer("COM3").unwrap();
        let export = temp.0.join("export.txt");
        manager
            .save_log_as("COM3", export.to_str().unwrap())
            .unwrap();
        assert_eq!(fs::read_to_string(export).unwrap(), "中\n");
    }
}

#[test]
fn copied_size_is_preserved_for_the_next_split() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    open(&manager, "COM3");
    manager
        .write("COM3", "t", "TX", &vec![b'x'; 1024 * 1024])
        .unwrap();
    let new = temp.0.join("new");
    manager
        .migrate_directory_with(&old, &new, force_copy)
        .unwrap();
    let copied = manager.writer_path("COM3").unwrap();
    assert!(lock_mutex(&manager.writer_lock("COM3").unwrap()).current_size() >= 1024 * 1024);
    manager.test_settings(|settings| {
        settings.split_enabled = true;
        settings.split_size_mb = 1;
    });
    manager.write("COM3", "t", "TX", b"split").unwrap();
    let next = manager.writer_path("COM3").unwrap();
    assert_ne!(copied, next);
    assert!(next.starts_with(&new));
    manager.close_all().unwrap();
}

#[test]
fn committed_cleanup_failure_keeps_new_owner_and_reports_only_successful_deletes() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    open(&manager, "COM3");
    manager.write("COM3", "t", "TX", b"before").unwrap();
    let new = temp.0.join("new");
    let migrated = manager
        .migrate_directory_with(&old, &new, |source, target| {
            fs::hard_link(source, target)?;
            // Simulate an external replacement that makes source cleanup fail. The
            // prepared target still owns the original bytes; cleanup must not recurse.
            fs::remove_file(source)?;
            fs::create_dir(source)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(migrated, 0);
    assert_eq!(manager.get_directory(), new);
    manager.write("COM3", "t", "TX", b"after").unwrap();
    let export = temp.0.join("export.txt");
    manager
        .save_log_as("COM3", export.to_str().unwrap())
        .unwrap();
    assert_eq!(fs::read_to_string(export).unwrap(), "before\nafter\n");
    manager.close_all().unwrap();
}

#[cfg(windows)]
#[test]
fn parent_cleanup_failure_preserves_both_custom_template_attributions() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("port");
    manager.test_settings(|settings| settings.filename_format = "log_[com]_custom".into());
    open(&manager, "COM3");
    manager.write("COM3", "t", "TX", b"before").unwrap();
    let source = manager.writer_path("COM3").unwrap();
    // A reader that denies FILE_SHARE_DELETE permits staging reads but makes
    // cleanup fail reliably on every supported Windows/Rust version.
    let _deny_delete = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&source)
        .unwrap();
    assert_eq!(
        manager
            .migrate_directory_with(&old, &temp.0, force_copy)
            .unwrap(),
        0
    );
    assert!(source.is_file());
    manager.write("COM3", "t", "TX", b"after").unwrap();
    manager.close_all().unwrap();
    let files = manager.list_files().unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|entry| entry.port_id == "COM3"));
}

#[cfg(any(unix, windows))]
fn directory_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(any(unix, windows))]
#[test]
fn same_physical_root_alias_remains_a_noop_after_settings_are_applied() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    manager.test_settings(|settings| {
        settings.filename_format = "log_[com]_custom".into();
        settings.new_file_per_session = true;
    });
    open(&manager, "COM3");
    manager.write_rx("COM3", "t", b"tail-").unwrap();
    let original = manager.writer_path("COM3").unwrap();
    let alias = temp.0.join("alias");
    directory_link(&old, &alias);
    assert_eq!(manager.migrate_directory(&old, &alias).unwrap(), 0);
    manager.test_settings(|settings| settings.directory = alias.to_string_lossy().into_owned());
    assert_eq!(
        manager.writer_path("COM3").unwrap(),
        alias.join(original.file_name().unwrap())
    );
    assert_eq!(manager.list_files().unwrap().len(), 1);
    manager.write_rx("COM3", "t", b"end\n").unwrap();
    manager.close_all().unwrap();
    let export = temp.0.join("export.txt");
    manager
        .save_log_as("COM3", export.to_str().unwrap())
        .unwrap();
    assert_eq!(fs::read_to_string(export).unwrap(), "tail-end\n");
    assert_eq!(manager.list_files().unwrap()[0].port_id, "COM3");
}

#[cfg(any(unix, windows))]
#[test]
fn nested_directory_links_never_import_or_remove_logs_outside_the_root() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    let outside = temp.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private.log"), b"must remain outside").unwrap();
    let link = old.join("escape");
    directory_link(&outside, &link);
    let new = temp.0.join("new");
    let moved = manager
        .migrate_directory_with(&old, &new, force_copy)
        .unwrap();
    assert_eq!(
        fs::read(outside.join("private.log")).unwrap(),
        b"must remain outside"
    );
    assert_eq!(moved, 0);
    assert!(!new.join("escape/private.log").exists());
}

#[test]
fn migration_serializes_io_and_lifecycle_but_panic_flush_never_waits() {
    let temp = TestRoot::new();
    let (manager, old) = temp.manager("none");
    open(&manager, "COM3");
    open(&manager, "COM9");
    manager.write("COM3", "t", "TX", b"before").unwrap();
    let manager = Arc::new(manager);
    let new = temp.0.join("new");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let migrating = Arc::clone(&manager);
    let target = new.clone();
    let migration = std::thread::spawn(move || {
        let mut first = true;
        migrating
            .migrate_directory_with(&old, &target, |_, _| {
                if first {
                    first = false;
                    entered_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                }
                force_copy(Path::new(""), Path::new(""))
            })
            .unwrap()
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let mut workers = Vec::new();
    for index in 0..4 {
        let manager = Arc::clone(&manager);
        let started = started_tx.clone();
        let done = done_tx.clone();
        workers.push(std::thread::spawn(move || {
            started.send(()).unwrap();
            match index {
                0 => manager.write("COM3", "t", "TX", b"after").unwrap(),
                1 => {
                    manager.list_files().unwrap();
                }
                2 => open(&manager, "COM4"),
                _ => manager.close_writer("COM9").unwrap(),
            }
            done.send(()).unwrap();
        }));
    }
    for _ in 0..4 {
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    assert!(done_rx.try_recv().is_err());
    let (panic_tx, panic_rx) = mpsc::channel();
    let panic_manager = Arc::clone(&manager);
    let panic_flush = std::thread::spawn(move || {
        panic_manager.flush_all_best_effort();
        panic_tx.send(()).unwrap();
    });
    let panic_did_not_wait = panic_rx.recv_timeout(Duration::from_secs(1)).is_ok();
    resume_tx.send(()).unwrap();
    assert!(migration.join().unwrap() >= 1);
    for worker in workers {
        worker.join().unwrap();
    }
    panic_flush.join().unwrap();
    assert!(panic_did_not_wait);
    let export = temp.0.join("export.txt");
    manager
        .save_log_as("COM3", export.to_str().unwrap())
        .unwrap();
    assert_eq!(fs::read_to_string(export).unwrap(), "before\nafter\n");
    assert!(manager.writer_path("COM4").unwrap().starts_with(new));
    manager.close_all().unwrap();
}
