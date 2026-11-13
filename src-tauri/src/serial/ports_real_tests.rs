//! Behavioral real-port tests. Keep serialport mocks out of the Windows test
//! binary (its harness has no application manifest; see ports_real.rs).
use super::{close, set_flow_control, set_params, write_handle, SerialPortHandle, WriterLeases};
use crate::commands::OpenPortArgs;
use crate::serial::SerialManager;
use serialport::{ClearBuffer, DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::io::{Read, Write};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone)]
struct MockPort {
    calls: Arc<Mutex<Vec<String>>>,
    read_release: Arc<(Mutex<bool>, Condvar)>,
    read_started: mpsc::Sender<()>,
}

impl Read for MockPort {
    fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
        self.read_started.send(()).unwrap();
        let (released, ready) = &*self.read_release;
        let mut released = released.lock().unwrap();
        while !*released {
            released = ready.wait(released).unwrap();
        }
        Err(std::io::ErrorKind::TimedOut.into())
    }
}

impl Write for MockPort {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.calls.lock().unwrap().push(format!("tx:{bytes:?}"));
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        panic!("serial TX must not flush a flow-controlled device")
    }
}

impl MockPort {
    fn record(&self, call: String) -> serialport::Result<()> {
        self.calls.lock().unwrap().push(call);
        Ok(())
    }
}

impl SerialPort for MockPort {
    fn name(&self) -> Option<String> {
        Some("TEST".into())
    }
    fn baud_rate(&self) -> serialport::Result<u32> {
        Ok(9600)
    }
    fn data_bits(&self) -> serialport::Result<DataBits> {
        Ok(DataBits::Eight)
    }
    fn flow_control(&self) -> serialport::Result<FlowControl> {
        Ok(FlowControl::None)
    }
    fn parity(&self) -> serialport::Result<Parity> {
        Ok(Parity::None)
    }
    fn stop_bits(&self) -> serialport::Result<StopBits> {
        Ok(StopBits::One)
    }
    fn timeout(&self) -> Duration {
        Duration::from_millis(100)
    }
    fn set_baud_rate(&mut self, value: u32) -> serialport::Result<()> {
        self.record(format!("baud:{value}"))
    }
    fn set_data_bits(&mut self, value: DataBits) -> serialport::Result<()> {
        self.record(format!("bits:{value:?}"))
    }
    fn set_flow_control(&mut self, value: FlowControl) -> serialport::Result<()> {
        self.record(format!("flow:{value:?}"))
    }
    fn set_parity(&mut self, value: Parity) -> serialport::Result<()> {
        self.record(format!("parity:{value:?}"))
    }
    fn set_stop_bits(&mut self, value: StopBits) -> serialport::Result<()> {
        self.record(format!("stop:{value:?}"))
    }
    fn set_timeout(&mut self, _value: Duration) -> serialport::Result<()> {
        Ok(())
    }
    fn write_request_to_send(&mut self, value: bool) -> serialport::Result<()> {
        self.record(format!("rts:{value}"))
    }
    fn write_data_terminal_ready(&mut self, value: bool) -> serialport::Result<()> {
        self.record(format!("dtr:{value}"))
    }
    fn read_clear_to_send(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_data_set_ready(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_ring_indicator(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn read_carrier_detect(&mut self) -> serialport::Result<bool> {
        Ok(false)
    }
    fn bytes_to_read(&self) -> serialport::Result<u32> {
        Ok(0)
    }
    fn bytes_to_write(&self) -> serialport::Result<u32> {
        Ok(0)
    }
    fn clear(&self, _buffer: ClearBuffer) -> serialport::Result<()> {
        Ok(())
    }
    fn try_clone(&self) -> serialport::Result<Box<dyn SerialPort>> {
        Ok(Box::new(self.clone()))
    }
    fn set_break(&self) -> serialport::Result<()> {
        Ok(())
    }
    fn clear_break(&self) -> serialport::Result<()> {
        Ok(())
    }
}

#[test]
fn blocked_read_does_not_block_parameters_control_lines_send_or_close_detach() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let read_release = Arc::new((Mutex::new(false), Condvar::new()));
    let (started_tx, started_rx) = mpsc::channel();
    let mut reader = MockPort {
        calls: Arc::clone(&calls),
        read_release: Arc::clone(&read_release),
        read_started: started_tx,
    };
    let writer = reader.try_clone().unwrap();
    // Simulate the idle reader stuck in read(), not a probabilistic mutex race.
    let read_thread = std::thread::spawn(move || {
        let _ = reader.read(&mut [0; 1]);
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut manager = SerialManager::new();
    manager.ports.insert(
        "TEST".into(),
        SerialPortHandle {
            write_port: Arc::new(Mutex::new(writer)),
            leases: Arc::new(WriterLeases {
                count: Mutex::new(0),
                empty: Condvar::new(),
            }),
            running: Arc::new(AtomicBool::new(true)),
            read_thread: Some(read_thread),
        },
    );
    manager.connection_generations.insert("TEST".into(), 7);
    manager.last_params.insert(
        "TEST".into(),
        OpenPortArgs {
            port_id: "TEST".into(),
            baud_rate: 9600,
            data_bits: 8,
            parity: "None".into(),
            stop_bits: "One".into(),
            handshake: "None".into(),
            dtr: false,
            rts: false,
            cols: 80,
            rows: 24,
        },
    );
    let manager = Arc::new(Mutex::new(manager));
    {
        let manager = manager.lock().unwrap();
        let error = set_flow_control(&manager, "TEST", true, true, Some(6)).unwrap_err();
        assert!(error
            .to_string()
            .contains("connection changed before applying flow control"));
    }
    let (finished_tx, finished_rx) = mpsc::channel();
    let worker_manager = Arc::clone(&manager);
    let worker = std::thread::spawn(move || {
        let lease = {
            let mut manager = worker_manager.lock().unwrap();
            set_params(&mut manager, "TEST", 115200, 8, "None", "One", "None").unwrap();
            for enabled in [true, false] {
                manager
                    .set_flow_control("TEST", enabled, enabled, Some(7))
                    .unwrap();
            }
            let params = manager.last_params.get("TEST").unwrap();
            assert!(!params.dtr);
            assert!(!params.rts);
            write_handle(&manager, "TEST").unwrap()
        };
        {
            let mut writer = lease.lock().unwrap();
            super::write_all_with_deadline("TEST", &mut **writer, b"hello", Duration::from_secs(5))
                .unwrap();
        }
        drop(lease);
        let close = close(&mut worker_manager.lock().unwrap(), "TEST").unwrap();
        finished_tx.send(close).unwrap();
    });
    // Even before read() returns, the commands must finish and close must be
    // able to detach the session. Never leave the test hung on a failure.
    let result = finished_rx.recv_timeout(Duration::from_secs(5));
    let progressed_while_read_blocked = result.is_ok();
    let close = match result {
        Ok(close) => close,
        Err(_) => {
            *read_release.0.lock().unwrap() = true;
            read_release.1.notify_all();
            finished_rx.recv_timeout(Duration::from_secs(5)).unwrap()
        }
    };
    assert!(
        manager.try_lock().is_ok(),
        "close must release the manager lock before joining"
    );
    let (closed_tx, closed_rx) = mpsc::channel();
    let closer = std::thread::spawn(move || {
        close.join().unwrap();
        closed_tx.send(()).unwrap();
    });
    // Reader cleanup remains owned by close (no detached OS handle leak).
    if progressed_while_read_blocked {
        assert!(closed_rx.recv_timeout(Duration::from_millis(20)).is_err());
    }
    *read_release.0.lock().unwrap() = true;
    read_release.1.notify_all();
    closed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    worker.join().unwrap();
    closer.join().unwrap();
    assert!(
        progressed_while_read_blocked,
        "parameter/control-line commands waited for the reader"
    );
    assert_eq!(
        *calls.lock().unwrap(),
        [
            "baud:115200",
            "bits:Eight",
            "parity:None",
            "stop:One",
            "flow:None",
            "dtr:true",
            "rts:true",
            "dtr:false",
            "rts:false",
            "tx:[104, 101, 108, 108, 111]",
        ]
    );
}
