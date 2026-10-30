//! Opt-in real WebView2 transport smoke. Uses a fresh temporary browser profile
//! and a hidden native window, never the user's HyperCom config or plugin data.
//! The full Tauri main-window authorization/UI layout is intentionally outside
//! this harness; the production SDK, native validators and document gate run.
use super::{EphemeralDirectory, ViewParent};
use super::super::{Binding, DocumentState, Session, TokenBucket, timeline};
use std::{cell::{Cell, RefCell}, rc::Rc, sync::{Arc, Mutex, atomic::AtomicBool}, time::{Duration, Instant}};
use serde_json::{Value, json};
use windows::{core::{w, PCWSTR}, Win32::UI::WindowsAndMessaging::{CreateWindowExW, PeekMessageW, TranslateMessage, DispatchMessageW, MSG, PM_REMOVE, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW}};
use wry::{WebContext, WebView, WebViewBuilder, WebViewExtWindows};
use webview2_com::NavigationStartingEventHandler;

fn pump_until(mut ready: impl FnMut() -> bool, description: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready() {
        assert!(Instant::now() < deadline, "WebView2 smoke timed out: {description}");
        unsafe {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn html(document_id: &str) -> String {
    format!(r#"<!doctype html><html><body><output id="actual">waiting</output><script>
const timeline = view.timeline.register({{
  version: 1, clock: {{kind:'custom',id:'device-ms'}},
  capabilities: {{preview:'bounded',canDrive:true}},
  async onSeek({{timeMs,signal}}) {{
    if(signal.aborted) return {{status:'held'}};
    globalThis.seekCalls = (globalThis.seekCalls || 0) + 1;
    document.getElementById('actual').textContent = String(timeMs - 1);
    await new Promise(resolve => setTimeout(resolve, 0));
    if(signal.aborted) return {{status:'held'}};
    return {{status:'nearest',actualTimeMs:timeMs-1,recordKey:String(globalThis.seekCalls)}};
  }}
}});
globalThis.timelineHandle = timeline;
view.onState(() => new Promise(() => {{}}));
__hypercomViewDocumentStart({});
</script></body></html>"#, serde_json::to_string(document_id).unwrap())
}
fn dispatch(webview: &WebView, session: &Session, message: &Value) -> bool {
    let Some(document_id) = message["documentId"].as_str() else { return false; };
    if !session.accepts_document(document_id) { return false; }
    if matches!(message["type"].as_str(), Some("timeline-seek" | "timeline-cancel")) && !timeline::validate_host(message) { return false; }
    let encoded = serde_json::to_string(message).unwrap();
    let literal = serde_json::to_string(&encoded).unwrap();
    webview.evaluate_script(&format!("globalThis.__hypercomViewDispatch(JSON.parse({literal}));")).unwrap();
    true
}
fn seek(document_id: &str, capability: &str, request_id: &str, time: f64) -> Value {
    json!({"type":"timeline-seek","documentId":document_id,"timeline":{
        "requestId":request_id,"capabilityGeneration":capability,"groupId":"native-group",
        "navigationEpoch":1,"gestureId":"native-gesture","requestSeq":1,"mappingRevision":0,
        "participantGeneration":1,"sourceGeneration":0,"timeMs":time,"phase":"commit","align":"center"
    }})
}
fn registration(messages: &[Value], document: &str) -> Option<String> {
    messages.iter().find(|m| m["documentId"] == document && m["payload"]["action"] == "register")
        .and_then(|m| m["payload"]["capabilityGeneration"].as_str()).map(str::to_owned)
}
fn ack(messages: &[Value], request_id: &str) -> Option<Value> {
    messages.iter().find(|m| m["payload"]["action"] == "ack" && m["payload"]["requestId"] == request_id).cloned()
}

#[test]
#[ignore = "requires the native Windows WebView2 runtime"]
fn workerless_timeline_native_webview2_smoke() {
    let profile = EphemeralDirectory(std::env::temp_dir().join(format!("hypercom-timeline-smoke-{}", uuid::Uuid::new_v4())));
    let mut context = WebContext::new(Some(profile.0.clone()));
    let parent = ViewParent(unsafe {
        CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), PCWSTR::null(), WS_OVERLAPPEDWINDOW, 0, 0, 800, 600, None, None, None, None).unwrap()
    });
    let binding = Binding { plugin_id: "com.example.native-timeline".into(), install_generation: uuid::Uuid::new_v4().to_string(), view_id: "page".into(), tab_id: uuid::Uuid::new_v4().to_string(), placement: "workspace-tab".into(), bound_port_id: None, tab_session_id: uuid::Uuid::new_v4().to_string(), view_instance_id: uuid::Uuid::new_v4().to_string(), port_mode: None, worker_epoch: 0, stream_epoch: 0 };
    let session = Arc::new(Session { binding, alive: AtomicBool::new(true), trusted_web: true, permission: None,
        rate: Mutex::new((Instant::now(), 0)), control_rate: Mutex::new(TokenBucket::new(128.0)),
        timeline_preview_rate: Mutex::new(TokenBucket::new(20.0)), timeline_control_rate: Mutex::new(TokenBucket::new(64.0)),
        binary_rate_reported: AtomicBool::new(false), document: Mutex::new(DocumentState::default()) });
    let first_document = uuid::Uuid::new_v4().to_string(); session.begin_document(&first_document);
    let sdk = include_str!("sdk.js").replace("__HOST_TRUSTED_WEB__", "true").replace("__HOST_HAS_WORKER__", "false")
        .replace("__HOST_VIEW_CONTEXT__", &serde_json::to_string(&session.binding).unwrap());
    let messages = Rc::new(RefCell::new(Vec::<Value>::new())); let incoming = messages.clone();
    let rejected = Rc::new(Cell::new(0usize)); let rejected_ipc = rejected.clone();
    let ipc_session = session.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_visible(false).with_devtools(false).with_incognito(true)
        .with_initialization_script(&sdk)
        .with_ipc_handler(move |request| {
            let value: Value = serde_json::from_str(request.body()).unwrap();
            let current = value["documentId"].as_str().is_some_and(|document| ipc_session.accepts_document(document));
            if !current { rejected_ipc.set(rejected_ipc.get() + 1); return; }
            if value["type"] == "timeline" { assert!(timeline::validate_page(&value["payload"]), "invalid real page timeline: {value}"); }
            incoming.borrow_mut().push(value);
        })
        .with_html(html(&first_document)).build(&parent).unwrap();
    let pending_document = Rc::new(RefCell::new(None::<String>));
    let next_document_on_navigation = pending_document.clone();
    let navigation_session = session.clone();
    let mut navigation_token = 0;
    unsafe {
        webview.webview().add_NavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, _| {
            if let Some(document) = next_document_on_navigation.borrow_mut().take() { navigation_session.begin_document(&document); }
            Ok(())
        })), &mut navigation_token).unwrap();
    }
    pump_until(|| registration(&messages.borrow(), &first_document).is_some(), "worker:false registration");
    let first_capability = registration(&messages.borrow(), &first_document).unwrap();
    println!("WebView2 worker:false register: document={first_document}, capability={first_capability}");
    assert!(dispatch(&webview, &session, &json!({"type":"init","documentId":first_document,"context":session.binding,"environment":{}})));
    assert!(dispatch(&webview, &session, &json!({"type":"state","documentId":first_document,"revision":1,"snapshot":{}})));
    assert!(dispatch(&webview, &session, &seek(&first_document, &first_capability, "native-first", 5000.0)));
    pump_until(|| ack(&messages.borrow(), "native-first").is_some(), "seek ACK while state handler is stalled");
    let first_ack = ack(&messages.borrow(), "native-first").unwrap();
    assert_eq!(first_ack["payload"]["result"], json!({"status":"nearest","actualTimeMs":4999,"recordKey":"1"}));
    assert!(!messages.borrow().iter().any(|m| m["type"] == "state-ack"));
    webview.evaluate_script("timelineHandle.beginNavigation('align').end({timeMs:6000,recordKey:'row-6'});").unwrap();
    pump_until(|| messages.borrow().iter().any(|m| m["payload"]["action"] == "end"), "source begin/end controls");
    assert!(messages.borrow().iter().any(|m| m["payload"]["action"] == "end" && m["payload"]["anchor"]["timeMs"] == 6000));
    println!("WebView2 independent seek/ACK and final source controls: passed");

    // A real top-level WebView2 NavigationStarting callback retires the old
    // document before the fresh page can register its SDK capability.
    let next_document = uuid::Uuid::new_v4().to_string();
    *pending_document.borrow_mut() = Some(next_document.clone());
    webview.load_html(&html(&next_document)).unwrap();
    pump_until(|| session.current_document().as_deref() == Some(&next_document), "native NavigationStarting identity rotation");
    assert!(!dispatch(&webview, &session, &seek(&first_document, &first_capability, "native-stale-host", 1.0)));
    pump_until(|| registration(&messages.borrow(), &next_document).is_some(), "navigation re-registration");
    let next_capability = registration(&messages.borrow(), &next_document).unwrap(); assert_ne!(first_capability, next_capability);
    let forged = json!({"type":"timeline","documentId":first_document,"payload":{"action":"ack","capabilityGeneration":first_capability,"requestId":"native-stale-page","result":{"status":"exact","actualTimeMs":1}}});
    webview.evaluate_script(&format!("ipc.postMessage({});", serde_json::to_string(&serde_json::to_string(&forged).unwrap()).unwrap())).unwrap();
    pump_until(|| rejected.get() > 0, "native stale document IPC rejection");
    assert!(!messages.borrow().iter().any(|m| m["payload"]["requestId"] == "native-stale-page"));
    // Wrong capability in the new document must not run its callback either.
    assert!(dispatch(&webview, &session, &seek(&next_document, &first_capability, "native-stale-capability", 2.0)));
    assert!(dispatch(&webview, &session, &seek(&next_document, &next_capability, "native-after-navigation", 7000.0)));
    pump_until(|| ack(&messages.borrow(), "native-after-navigation").is_some(), "fresh document seek ACK");
    assert_eq!(ack(&messages.borrow(), "native-after-navigation").unwrap()["payload"]["result"], json!({"status":"nearest","actualTimeMs":6999,"recordKey":"1"}));
    assert!(ack(&messages.borrow(), "native-stale-capability").is_none());
    println!("WebView2 navigation invalidation, stale host/page/capability rejection and new seek ACK: passed");
    drop(webview);
}

/// Import production modules from the controlled Vite origin only after the
/// dedicated fixture DOM exists. No copied scroll-mapping algorithm or App boot.
fn geometry_initialization(origin: &str) -> String {
    r###"(() => {
  if (window !== window.top || location.origin !== __GEOMETRY_ORIGIN__ || location.pathname !== '/e2e/fixtures/native-geometry.html') return;
  const post = value => ipc.postMessage(JSON.stringify(value));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  // Hidden WebView timer throttling is unrelated to geometry. Yield real task
  // turns without timers; subsequent DOM metric reads force actual layout.
  const settle = () => new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(null); });
  const start = async () => {
    const [{ TerminalBuffer }, { TerminalRenderer }] = await Promise.all([
      import('/src/utils/terminal/TerminalBuffer.ts'),
      import('/src/utils/terminal/TerminalRenderer.ts'),
    ]);
    const count = 1000000;
    const buffer = new TerminalBuffer({ maxLines: count });
    for (let i = 0; i < count; i++) {
      buffer.append({ timestamp: 1700000000000 + i, direction: 'RX', content: `row-${i}` });
      if (i && i % 100000 === 0) await settle();
    }
    assert(buffer.length === count && buffer.firstSeq === 0 && buffer.lastSeq === count - 1, 'actual TerminalBuffer did not retain one million records');
    const view = { visibleSeqs: null, visibleSeqsOffset: 0, frozenSeq: null, matchSet: null,
      currentMatchSeq: -1, searchQuery: '', searchCaseSensitive: false, selectedRange: null,
      locked: false, gestureActive: false, followEnabled: false };
    globalThis.__hypercomRunGeometry = async zoom => {
      const cases = [];
      try {
        await settle(); await settle();
        assert(getComputedStyle(document.documentElement).zoom === '1' && getComputedStyle(document.body).zoom === '1', 'CSS zoom must not replace native WebView zoom');
        for (const rowHeight of [12, 72]) {
          const container = document.createElement('div');
          Object.assign(container.style, { width: `${Math.max(160, innerWidth - 32)}px`, height: `${Math.max(160, Math.min(400, innerHeight - 32))}px`, overflow: 'auto', overflowAnchor: 'none', boxSizing: 'content-box', margin: '0', padding: '0', fontSize: rowHeight === 12 ? '8px' : '48px' });
          document.body.replaceChildren(container);
          const renderer = new TerminalRenderer({ rowHeight, showTimestamp: false, displayFormat: 'string', encoding: 'UTF-8', timestampFormat: 'absolute', timestampMode: 'perLine', highlightRuleSets: [], connectedAt: null });
          renderer.attachToContainer(container); renderer.render(buffer, view); await settle();
          const visible = seq => {
            const node = container.querySelector(`[data-seq="${seq}"]`);
            assert(node, `row ${seq} was not rendered at height ${rowHeight}`);
            const rect = node.getBoundingClientRect(), box = container.getBoundingClientRect();
            const top = box.top + container.clientTop, bottom = top + container.clientHeight;
            assert(rect.bottom > top && rect.top < bottom, `row ${seq} is outside the real viewport: ${JSON.stringify({ top, bottom, rowTop: rect.top, rowBottom: rect.bottom })}`);
            assert(Math.abs(rect.height - rowHeight) < 2, `actual row height ${rect.height} differs from ${rowHeight}`);
            assert(node.textContent.includes(`row-${seq}`), `row ${seq} did not use actual buffer content`);
            return { top: rect.top - top, bottom: rect.bottom - top };
          };
          const sample = phase => {
            const anchor = renderer.readGeometryAnchor(buffer, view);
            assert(anchor, `missing ${phase} geometry anchor`);
            visible(anchor.seq);
            const seqs = [...container.querySelectorAll('.terminal-line')].map(node => Number(node.dataset.seq));
            assert(seqs.every((seq, index) => !index || seq > seqs[index - 1]), 'DOM record ordering is not monotonic');
            assert(seqs.length <= Math.ceil(container.clientHeight / rowHeight) + 32, 'renderer DOM is not bounded');
            return { phase, anchor: anchor.seq, scrollTop: container.scrollTop, scrollHeight: container.scrollHeight, clientHeight: container.clientHeight, rowNodes: seqs.length };
          };
          const raw = [];
          for (const fraction of [0, .25, .5, .75, 1]) {
            container.scrollTop = fraction === 1 ? Number.MAX_SAFE_INTEGER : fraction * (container.scrollHeight - container.clientHeight);
            renderer.render(buffer, view); await settle(); renderer.render(buffer, view);
            raw.push(sample(`raw-${fraction}`));
          }
          assert(raw.every((entry, index) => !index || (entry.scrollTop > raw[index - 1].scrollTop && entry.anchor > raw[index - 1].anchor)), `native scrollbar mapping is not monotonic at height ${rowHeight}`);
          assert(Math.abs(raw[2].anchor - count / 2) < 100, `middle scrollbar does not address middle records: ${raw[2].anchor}`);
          visible(count - 1);
          assert(renderer.readGeometryAnchor(buffer, view, 'end').seq === count - 1, 'native scrollbar tail is unreachable');
          const tailMax = raw[4].scrollHeight - raw[4].clientHeight;
          assert(Math.abs(raw[4].scrollTop - tailMax) <= 2, 'native scrollTop did not reach its physical maximum');
          const seeks = [];
          for (const [seq, align] of [[0, 'start'], [500000, 'center'], [999999, 'end']]) {
            renderer.scrollToSeq(seq, align, buffer, view); await settle(); renderer.render(buffer, view);
            const rect = visible(seq), actual = renderer.readGeometryAnchor(buffer, view, align);
            assert(actual && Math.abs(actual.seq - seq) <= 1, `actual renderer seek landed on ${actual && actual.seq}, expected ${seq}`);
            seeks.push({ seq, align, actualSeq: actual.seq, scrollTop: container.scrollTop, rect });
          }
          assert(seeks[0].scrollTop < seeks[1].scrollTop && seeks[1].scrollTop < seeks[2].scrollTop, 'scheduled positions are not monotonic');
          cases.push({ rowHeight, raw, seeks });
          renderer.dispose(); container.remove();
        }
        post({ type: 'geometry-result', ok: true, zoom, devicePixelRatio, cssZoom: getComputedStyle(document.documentElement).zoom, rows: buffer.length, cases });
      } catch (error) { post({ type: 'geometry-result', ok: false, zoom, error: String(error && error.stack || error), cases }); }
    };
    post({ type: 'geometry-ready', rows: buffer.length, bufferModule: new URL('/src/utils/terminal/TerminalBuffer.ts', location.href).href, rendererModule: new URL('/src/utils/terminal/TerminalRenderer.ts', location.href).href });
  };
  const run = () => { void start().catch(error => post({ type: 'geometry-error', error: String(error && error.stack || error) })); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true }); else run();
})();"###.replace("__GEOMETRY_ORIGIN__", &serde_json::to_string(origin).unwrap())
}

#[test]
#[ignore = "requires Windows WebView2 and controlled Vite HYPERCOM_GEOMETRY_URL"]
fn renderer_geometry_native_webview2_smoke() {
    let configured = std::env::var("HYPERCOM_GEOMETRY_URL").expect("Set HYPERCOM_GEOMETRY_URL to the controlled Vite origin, e.g. http://127.0.0.1:1420/");
    let mut fixture = url::Url::parse(&configured).expect("HYPERCOM_GEOMETRY_URL must be an HTTP(S) URL");
    assert!(matches!(fixture.scheme(), "http" | "https") && fixture.host_str().is_some() && fixture.username().is_empty() && fixture.password().is_none(), "Use a controlled HTTP(S) Vite URL without credentials");
    let origin = fixture.origin().ascii_serialization();
    fixture.set_path("/e2e/fixtures/native-geometry.html"); fixture.set_query(None); fixture.set_fragment(None);
    let profile = EphemeralDirectory(std::env::temp_dir().join(format!("hypercom-geometry-smoke-{}", uuid::Uuid::new_v4())));
    let mut context = WebContext::new(Some(profile.0.clone()));
    let parent = ViewParent(unsafe {
        CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), PCWSTR::null(), WS_OVERLAPPEDWINDOW, 0, 0, 800, 600, None, None, None, None).unwrap()
    });
    let messages = Rc::new(RefCell::new(Vec::<Value>::new())); let incoming = messages.clone(); let expected_origin = origin.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_visible(false).with_devtools(false).with_incognito(true)
        .with_initialization_script(&geometry_initialization(&origin))
        .with_ipc_handler(move |request| {
            if url::Url::parse(&request.uri().to_string()).ok().is_none_or(|uri| uri.origin().ascii_serialization() != expected_origin) { return; }
            if request.body().len() <= 64 * 1024 { if let Ok(value) = serde_json::from_str::<Value>(request.body()) { incoming.borrow_mut().push(value); } }
        }).with_url(fixture.as_str()).build(&parent).unwrap();
    pump_until(|| messages.borrow().iter().any(|m| m["type"] == "geometry-ready" || m["type"] == "geometry-error"), "actual Vite renderer imports / million-row buffer initialization");
    assert!(!messages.borrow().iter().any(|m| m["type"] == "geometry-error"), "geometry initialization failed: {}", serde_json::to_string(&*messages.borrow()).unwrap());
    println!("WebView2 production renderer imported: {}", serde_json::to_string(&*messages.borrow()).unwrap());
    let mut ratios = Vec::new();
    for zoom in [0.8, 2.0] {
        webview.zoom(zoom).unwrap();
        let mut actual_zoom = 0.0;
        unsafe { webview.controller().ZoomFactor(&mut actual_zoom).unwrap(); }
        assert!((actual_zoom - zoom).abs() < 0.000001, "native WebView2 ZoomFactor differs from requested factor");
        webview.evaluate_script(&format!("globalThis.__hypercomRunGeometry({zoom});")).unwrap();
        pump_until(|| messages.borrow().iter().any(|m| m["type"] == "geometry-result" && m["zoom"].as_f64() == Some(zoom)), "native zoom renderer first/middle/tail geometry");
        let result = messages.borrow().iter().find(|m| m["type"] == "geometry-result" && m["zoom"].as_f64() == Some(zoom)).unwrap().clone();
        println!("WebView2 geometry nativeZoom={actual_zoom}: {}", serde_json::to_string(&result).unwrap());
        assert_eq!(result["ok"], true, "actual renderer geometry failed: {result}");
        assert_eq!(result["rows"], 1_000_000); assert_eq!(result["cssZoom"], "1");
        let cases = result["cases"].as_array().unwrap(); assert_eq!(cases.len(), 2);
        assert_eq!(cases[0]["rowHeight"], 12); assert_eq!(cases[1]["rowHeight"], 72);
        ratios.push(result["devicePixelRatio"].as_f64().unwrap());
    }
    assert!(ratios[1] > ratios[0] * 2.0, "native zoom did not change observed browser devicePixelRatio: {ratios:?}");
    println!("WebView2 million-row actual renderer geometry: rowHeight=12/72, nativeZoom=0.8/2, raw scrollbar + seek first/middle/tail passed");
    drop(webview);
}
