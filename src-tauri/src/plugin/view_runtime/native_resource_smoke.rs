//! Real WebView2 reads through the shipped declaration and response adapter.
//! No Tauri user profile, OS device, external origin or replacement router.
use std::{
    cell::RefCell,
    fs::{self, File},
    io::{Seek, SeekFrom, Write},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::{
    core::{w, HSTRING, PCWSTR},
    Win32::{
        System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_END, STREAM_SEEK_SET},
        UI::WindowsAndMessaging::{CreateWindowExW, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW},
    },
};
use wry::{WebContext, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

use super::super::resources::{snapshot_lazy, TestDirectory};
use super::{
    resource_response::{ResourceServer, SelectedResponse},
    timeline_smoke::pump_until,
    ViewParent,
};

const NINE_MIB: usize = 9 * 1024 * 1024;

fn fixture(root: &TestDirectory, html: &str) -> ResourceServer {
    fs::write(root.path().join("index.html"), html).unwrap();
    let manifest = json!({
        "id":"com.example.native-resource-test", "name":"Native declared resources", "version":"1.0.0", "apiVersion":"1.0",
        "permissions":["ui:view"], "requires":["trusted-web-view@1", "plugin-workspace-tabs@1"],
        "ui":{"views":[{"id":"page", "label":"Page", "mode":"trusted-web", "worker":false,
            "entry":"index.html", "styles":[], "assets":["payload.bin", "empty.bin", "stale.bin"],
            "modes":["trx"], "input":"none", "placements":["workspace-tab"], "portBinding":"none"}]}
    });
    fs::write(root.path().join("manifest.json"), manifest.to_string()).unwrap();
    let manifest = crate::plugin::load_manifest_from_dir(root.path())
        .expect("fixture must pass production manifest/resource validation");
    let view = &manifest.ui.as_ref().unwrap().views[0];
    assert!(view.is_trusted_web());
    let resources = snapshot_lazy(root.path(), view).unwrap();
    assert_eq!(resources.len(), 4);
    ResourceServer {
        origin: super::trusted_origin(&manifest.id, &view.id),
        trusted: true,
        clipboard: false,
        resources: Rc::new(resources),
        alive: Arc::new(AtomicBool::new(true)),
    }
}

const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><script>
const post = v => ipc.postMessage(JSON.stringify(v));
const request = async (name, method = 'GET') => {
  const response = await fetch('/' + name, {method, cache:'no-store'});
  const bytes = await response.arrayBuffer();
  return {status:response.status, size:bytes.byteLength, length:response.headers.get('Content-Length'), bytes};
};
const summarize = async (name, method) => {
  const {status,size,length} = await request(name,method);
  return {status,size,length};
};
(async () => {
  const start = performance.now();
  const {status,size,length,bytes} = await request('payload.bin');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
  post({phase:'live',status,size,length,digest,fetchAndDigestMs:performance.now()-start,
    head:await summarize('payload.bin','HEAD'), empty:await summarize('empty.bin'), emptyHead:await summarize('empty.bin','HEAD'),
    unlisted:await summarize('unlisted.bin'), unlistedHead:await summarize('unlisted.bin','HEAD'),
    stale:await summarize('stale.bin'), staleHead:await summarize('stale.bin','HEAD')});
})().catch(e => post({phase:'error',error:String(e && e.stack || e)}));
window.checkRetiredResource = async () => {
  try { post({phase:'retired',get:await summarize('payload.bin'),head:await summarize('payload.bin','HEAD')}); }
  catch (e) { post({phase:'error',error:String(e && e.stack || e)}); }
};
</script>"#;

fn write_pattern(file: &mut File, length: usize) -> String {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 8192];
    for offset in (0..length).step_by(buffer.len()) {
        let count = (length - offset).min(buffer.len());
        for (i, value) in buffer[..count].iter_mut().enumerate() {
            let at = offset + i;
            *value = ((at * 37) ^ (at >> 7) ^ (at >> 16)) as u8;
        }
        file.write_all(&buffer[..count]).unwrap();
        hash.update(&buffer[..count]);
    }
    format!("{:x}", hash.finalize())
}

#[test]
#[ignore = "requires native Windows WebView2, a hidden HWND and an isolated temporary profile"]
fn declared_resource_native_webview2_smoke() {
    let root = TestDirectory::new();
    let profile = TestDirectory::new();
    let digest = write_pattern(
        &mut File::create(root.path().join("payload.bin")).unwrap(),
        NINE_MIB,
    );
    fs::write(root.path().join("empty.bin"), []).unwrap();
    fs::write(root.path().join("stale.bin"), b"original").unwrap();
    fs::write(root.path().join("unlisted.bin"), b"not declared").unwrap();
    let server = fixture(&root, PAGE);
    let alive = server.alive.clone();
    let origin = server.origin.clone();
    // Preserve the old inode so even same-size replacement cannot inherit it.
    fs::rename(
        root.path().join("stale.bin"),
        root.path().join("retained-old.bin"),
    )
    .unwrap();
    fs::write(root.path().join("stale.bin"), b"replaced").unwrap();

    let setup_started = Instant::now();
    let mut context = WebContext::new(Some(profile.path().to_path_buf()));
    let parent = ViewParent(unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            PCWSTR::null(),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            800,
            600,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    });
    let messages = Rc::new(RefCell::new(Vec::<Value>::new()));
    let incoming = messages.clone();
    let document = format!("{origin}/index.html");
    let expected_document = document.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_visible(false).with_devtools(false).with_incognito(false)
        .with_additional_browser_args("--disable-background-networking --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback> --host-resolver-rules=\"MAP * ~NOTFOUND\"")
        .with_ipc_handler(move |request| {
            if request.uri().to_string() == expected_document {
                if let Ok(value) = serde_json::from_str(request.body()) { incoming.borrow_mut().push(value); }
            }
        }).build(&parent).unwrap();
    let core = webview.webview();
    server
        .install(&core, webview.environment())
        .expect("production WebResourceRequested installation failed");
    let navigation_started = Instant::now();
    unsafe {
        core.Navigate(&HSTRING::from(&document)).unwrap();
    }
    pump_until(
        || !messages.borrow().is_empty(),
        "declared 9 MiB resource read and digested inside the WebView2 page",
    );
    let live = messages.borrow()[0].clone();
    assert_eq!(
        live["phase"], "live",
        "real browser did not read resource: {live}"
    );
    assert_eq!(live["status"], 200);
    assert_eq!(live["size"], NINE_MIB);
    assert_eq!(live["length"], NINE_MIB.to_string());
    assert_eq!(live["digest"], digest);
    assert_eq!(
        live["head"],
        json!({"status":200,"size":0,"length":NINE_MIB.to_string()})
    );
    for item in ["empty", "emptyHead"] {
        assert_eq!(
            live[item],
            json!({"status":200,"size":0,"length":"0"}),
            "{item}"
        );
    }
    for item in ["unlisted", "unlistedHead", "stale", "staleHead"] {
        assert_eq!(
            live[item],
            json!({"status":403,"size":0,"length":"0"}),
            "{item}"
        );
    }
    println!("WebView2 production declared resource: exposed={} bytes, sha256={}, fetch+digest_ms={}, setup_ms={}, navigation_and_all_checks_ms={}",
        NINE_MIB, digest, live["fetchAndDigestMs"], setup_started.elapsed().as_millis() - navigation_started.elapsed().as_millis(), navigation_started.elapsed().as_millis());

    alive.store(false, Ordering::Release);
    webview
        .evaluate_script("void window.checkRetiredResource();")
        .unwrap();
    pump_until(|| messages.borrow().len() >= 2, "live browser receives forbidden GET and HEAD after the real resource lifetime token is retired");
    let retired = messages.borrow()[1].clone();
    assert_eq!(
        retired,
        json!({"phase":"retired","get":{"status":403,"size":0,"length":"0"},"head":{"status":403,"size":0,"length":"0"}})
    );
    println!("WebView2 declaration/identity denial, valid zero bytes, HEAD and shared retirement: passed");
    drop(webview);
}

fn select(server: &ResourceServer, path: &str, method: &str) -> SelectedResponse {
    server.select(
        &format!("{}/{path}", server.origin),
        method,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
    )
}

fn read(stream: &IStream, bytes: &mut [u8]) -> (i32, u32) {
    let mut count = u32::MAX;
    let result = unsafe {
        stream.Read(
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
            Some(&mut count),
        )
    };
    (result.0, count)
}

#[test]
fn declared_resource_com_stream_keeps_verified_file_and_clone_lifetimes() {
    let root = TestDirectory::new();
    let length = 129 * 1024 * 1024 + 11;
    let payload = root.path().join("payload.bin");
    let mut file = File::create(&payload).unwrap();
    file.set_len(length).unwrap();
    file.write_all(b"HEAD").unwrap();
    file.seek(SeekFrom::End(-4)).unwrap();
    file.write_all(b"TAIL").unwrap();
    drop(file);
    fs::write(root.path().join("empty.bin"), []).unwrap();
    fs::write(root.path().join("stale.bin"), b"stale").unwrap();
    let server = fixture(&root, "<!doctype html>");
    let response = select(&server, "payload.bin", "GET");
    assert_eq!((response.status, response.length), (200, length));
    let stream = response
        .body
        .expect("declared GET must have an IStream body");
    let head = select(&server, "payload.bin", "HEAD");
    assert_eq!((head.status, head.length), (200, length));
    assert!(head.body.is_none());
    let empty = select(&server, "empty.bin", "GET");
    assert_eq!((empty.status, empty.length), (200, 0));
    assert_eq!(
        read(&empty.body.unwrap(), &mut [0]),
        (1, 0),
        "valid empty file must be EOF, not missing"
    );
    let mut stat = STATSTG::default();
    unsafe {
        stream.Stat(&mut stat, STATFLAG_NONAME).unwrap();
    }
    assert_eq!(stat.cbSize, length);
    assert_eq!(stat.r#type, 2);
    assert!(stat.pwcsName.is_null());
    let mut bytes = [0u8; 2];
    assert_eq!(read(&stream, &mut bytes), (0, 2));
    assert_eq!(&bytes, b"HE");
    let clone = unsafe { stream.Clone().unwrap() };
    let mut position = 0;
    unsafe {
        stream
            .Seek(-4, STREAM_SEEK_END, Some(&mut position))
            .unwrap();
    }
    assert_eq!(position, length - 4);
    // A verified open File is still the source after its path is moved. Any new
    // request for that declaration must recheck the namespace and fail closed.
    fs::rename(&payload, root.path().join("retained.bin")).unwrap();
    for method in ["GET", "HEAD"] {
        assert_eq!(select(&server, "payload.bin", method).status, 403);
    }
    assert_eq!(read(&clone, &mut bytes), (0, 2));
    assert_eq!(&bytes, b"AD");
    let mut tail = [0u8; 6];
    assert_eq!(read(&stream, &mut tail), (1, 4));
    assert_eq!(&tail[..4], b"TAIL");
    assert_eq!(read(&stream, &mut bytes), (1, 0));
    unsafe {
        stream.Seek(0, STREAM_SEEK_SET, None).unwrap();
    }
    assert_eq!(
        unsafe { stream.Read(bytes.as_mut_ptr().cast(), 2, None) }.0,
        0
    );
    assert_eq!(&bytes, b"HE");
    server.alive.store(false, Ordering::Release);
    for retained in [&stream, &clone] {
        bytes = [0xA5; 2];
        let (code, count) = read(retained, &mut bytes);
        assert!(code < 0);
        assert_eq!(count, 0);
        assert_eq!(bytes, [0xA5; 2]);
        assert!(unsafe { retained.Clone() }.is_err());
        assert!(unsafe { retained.Seek(0, STREAM_SEEK_SET, None) }.is_err());
    }
    assert_eq!(select(&server, "empty.bin", "GET").status, 403);
    println!("COM same-file length={length}, sampled header/tail only, independent clone offsets and retirement verified");
}
