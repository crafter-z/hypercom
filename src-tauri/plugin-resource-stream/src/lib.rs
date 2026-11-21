#![cfg(windows)]

use std::{
    fs::File,
    os::windows::fs::FileExt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use windows::Win32::System::Com::{
    ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE, STATFLAG, STATSTG, STGC, STREAM_SEEK,
};
use windows_core::{Error, HRESULT};

const S_OK: HRESULT = HRESULT(0);
const S_FALSE: HRESULT = HRESULT(1);
const E_NOTIMPL: HRESULT = HRESULT(0x80004001u32 as i32);
const E_FAIL: HRESULT = HRESULT(0x80004005u32 as i32);
const E_POINTER: HRESULT = HRESULT(0x80004003u32 as i32);
const STG_E_INVALIDFUNCTION: HRESULT = HRESULT(0x80030001u32 as i32);
const STG_E_ACCESSDENIED: HRESULT = HRESULT(0x80030005u32 as i32);
const STG_E_READFAULT: HRESULT = HRESULT(0x8003001eu32 as i32);
const READ_WINDOW: usize = 64 * 1024;

#[windows_core::implement(IStream)]
struct FileStream {
    file: Arc<File>,
    length: u64,
    position: Mutex<u64>,
    alive: Arc<AtomicBool>,
}

fn unsupported() -> Error {
    Error::new(
        E_NOTIMPL,
        "read-only resource stream operation is not supported",
    )
}

impl FileStream_Impl {
    fn require_live(&self) -> windows_core::Result<()> {
        if self.alive.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(Error::new(STG_E_ACCESSDENIED, "resource view retired"))
        }
    }
}

impl ISequentialStream_Impl for FileStream_Impl {
    fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
        if !pcbread.is_null() {
            unsafe {
                *pcbread = 0;
            }
        }
        if pv.is_null() && cb != 0 {
            return E_POINTER;
        }
        if let Err(error) = self.require_live() {
            return error.code();
        }
        let Ok(mut position) = self.position.lock() else {
            return E_FAIL;
        };
        let amount = self.length.saturating_sub(*position).min(u64::from(cb)) as usize;
        if amount == 0 {
            return if cb == 0 { S_OK } else { S_FALSE };
        }

        // No allocation proportional to either the declared file length or the
        // caller's Read size. Clones have independent positions; every Windows
        // read uses its explicit offset. Do not publish a block read after its
        // shared session has retired while the OS was reading it.
        let mut scratch = [0u8; READ_WINDOW];
        let mut done = 0;
        while done < amount {
            if let Err(error) = self.require_live() {
                return error.code();
            }
            let count = (amount - done).min(scratch.len());
            let read = match self
                .file
                .seek_read(&mut scratch[..count], *position + done as u64)
            {
                Ok(0) => return STG_E_READFAULT, // Shrink after validated length is not an empty success.
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return STG_E_READFAULT,
            };
            if let Err(error) = self.require_live() {
                return error.code();
            }
            unsafe {
                std::ptr::copy_nonoverlapping(scratch.as_ptr(), pv.cast::<u8>().add(done), read);
            }
            done += read;
        }
        *position += done as u64;
        if !pcbread.is_null() {
            unsafe {
                *pcbread = done as u32;
            }
        }
        if done == cb as usize {
            S_OK
        } else {
            S_FALSE
        }
    }

    fn Write(&self, _pv: *const core::ffi::c_void, _cb: u32, pcbwritten: *mut u32) -> HRESULT {
        if !pcbwritten.is_null() {
            unsafe {
                *pcbwritten = 0;
            }
        }
        STG_E_ACCESSDENIED
    }
}

impl IStream_Impl for FileStream_Impl {
    fn Seek(
        &self,
        move_by: i64,
        origin: STREAM_SEEK,
        new_position: *mut u64,
    ) -> windows_core::Result<()> {
        self.require_live()?;
        let mut position = self.position.lock().map_err(|_| Error::from(E_FAIL))?;
        let base = match origin {
            STREAM_SEEK(0) => 0,
            STREAM_SEEK(1) => i128::from(*position),
            STREAM_SEEK(2) => i128::from(self.length),
            _ => return Err(Error::from(STG_E_INVALIDFUNCTION)),
        };
        *position = u64::try_from(base + i128::from(move_by))
            .map_err(|_| Error::from(STG_E_INVALIDFUNCTION))?;
        if !new_position.is_null() {
            unsafe {
                *new_position = *position;
            }
        }
        Ok(())
    }
    fn SetSize(&self, _size: u64) -> windows_core::Result<()> {
        Err(Error::from(STG_E_ACCESSDENIED))
    }
    fn CopyTo(
        &self,
        _stream: windows_core::Ref<'_, IStream>,
        _count: u64,
        _read: *mut u64,
        _written: *mut u64,
    ) -> windows_core::Result<()> {
        Err(unsupported())
    }
    fn Commit(&self, _flags: &STGC) -> windows_core::Result<()> {
        Err(unsupported())
    }
    fn Revert(&self) -> windows_core::Result<()> {
        Err(unsupported())
    }
    fn LockRegion(&self, _offset: u64, _count: u64, _lock: &LOCKTYPE) -> windows_core::Result<()> {
        Err(unsupported())
    }
    fn UnlockRegion(&self, _offset: u64, _count: u64, _lock: u32) -> windows_core::Result<()> {
        Err(unsupported())
    }
    fn Stat(&self, stat: *mut STATSTG, _flags: &STATFLAG) -> windows_core::Result<()> {
        self.require_live()?;
        if stat.is_null() {
            return Err(Error::from(E_POINTER));
        }
        // Anonymous read-only STGTY_STREAM. Initialize all fields, including the
        // name pointer: consumers may release it even if only asking for size.
        unsafe {
            *stat = STATSTG {
                r#type: 2,
                cbSize: self.length,
                ..Default::default()
            };
        }
        Ok(())
    }
    fn Clone(&self) -> windows_core::Result<IStream> {
        self.require_live()?;
        let position = *self.position.lock().map_err(|_| Error::from(E_FAIL))?;
        Ok(FileStream {
            file: Arc::clone(&self.file),
            length: self.length,
            position: Mutex::new(position),
            alive: Arc::clone(&self.alive),
        }
        .into())
    }
}

/// Own exactly the verified file; opening and namespace authorization are the
/// caller's responsibility. Retiring the shared token also retires all clones.
pub fn from_file(file: File, length: u64, alive: Arc<AtomicBool>) -> IStream {
    FileStream {
        file: Arc::new(file),
        length,
        position: Mutex::new(0),
        alive,
    }
    .into()
}
