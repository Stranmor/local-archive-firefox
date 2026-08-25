use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::fmt::{Display, Formatter};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
struct LoaderError(String);

impl Display for LoaderError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for LoaderError {}

#[derive(Debug)]
struct Config {
    socket_path: PathBuf,
    addon_path: PathBuf,
    expected_id: String,
    expected_version: String,
    receipt_path: Option<PathBuf>,
    timeout: Duration,
}

#[derive(Debug)]
struct ManifestIdentity {
    addon_id: String,
    version: String,
    tree_sha256: String,
}

struct RdpConnection {
    reader: BufReader<UnixStream>,
    writer: BufWriter<UnixStream>,
}

impl RdpConnection {
    fn connect_ready(path: &Path, deadline: Instant) -> Result<(Self, Value), Box<dyn Error>> {
        let mut last_error = "socket has not appeared".to_owned();
        loop {
            if Instant::now() >= deadline {
                return Err(Box::new(LoaderError(format!(
                    "Firefox DevTools endpoint did not become ready at {}: {last_error}",
                    path.display()
                ))));
            }
            match UnixStream::connect(path) {
                Ok(stream) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    stream.set_read_timeout(Some(remaining.min(Duration::from_millis(500))))?;
                    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
                    let reader = BufReader::new(stream.try_clone()?);
                    let writer = BufWriter::new(stream);
                    let mut connection = Self { reader, writer };
                    match connection.read_frame() {
                        Ok(greeting)
                            if greeting.get("from").and_then(Value::as_str) == Some("root") =>
                        {
                            connection
                                .reader
                                .get_ref()
                                .set_read_timeout(Some(Duration::from_secs(5)))?;
                            return Ok((connection, greeting));
                        }
                        Ok(_) => {
                            "RDP greeting did not come from the root actor"
                                .clone_into(&mut last_error);
                        }
                        Err(error) => last_error = error.to_string(),
                    }
                }
                Err(error) => last_error = error.to_string(),
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    fn read_frame(&mut self) -> Result<Value, Box<dyn Error>> {
        read_frame_from(&mut self.reader)
    }

    fn request(
        &mut self,
        actor: &str,
        request_type: &str,
        fields: Map<String, Value>,
    ) -> Result<Value, Box<dyn Error>> {
        let mut request = Map::new();
        request.insert("to".to_owned(), Value::String(actor.to_owned()));
        request.insert("type".to_owned(), Value::String(request_type.to_owned()));
        request.extend(fields);
        let payload = serde_json::to_vec(&Value::Object(request))?;
        write!(self.writer, "{}:", payload.len())?;
        self.writer.write_all(&payload)?;
        self.writer.flush()?;

        loop {
            let response = self.read_frame()?;
            if response.get("from").and_then(Value::as_str) != Some(actor) {
                continue;
            }
            if let Some(error) = response.get("error").and_then(Value::as_str) {
                let message = response
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("no error detail");
                return Err(Box::new(LoaderError(format!(
                    "Firefox rejected {request_type}: {error}: {message}"
                ))));
            }
            return Ok(response);
        }
    }
}

fn read_frame_from(reader: &mut impl Read) -> Result<Value, Box<dyn Error>> {
    let mut length_bytes = Vec::with_capacity(12);
    loop {
        let mut byte = [0_u8; 1];
        reader.read_exact(&mut byte)?;
        if byte[0] == b':' {
            break;
        }
        if !byte[0].is_ascii_digit() || length_bytes.len() >= 20 {
            return Err(Box::new(LoaderError(
                "Firefox sent an invalid RDP frame length".to_owned(),
            )));
        }
        length_bytes.push(byte[0]);
    }
    let length = std::str::from_utf8(&length_bytes)?.parse::<usize>()?;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(Box::new(LoaderError(format!(
            "Firefox sent an out-of-range RDP frame length: {length}"
        ))));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(serde_json::from_slice(&payload)?)
}

fn parse_args() -> Result<Config, Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let mut socket_path = None;
    let mut addon_path = None;
    let mut expected_id = None;
    let mut expected_version = None;
    let mut receipt_path = None;
    let mut timeout = DEFAULT_TIMEOUT;

    while let Some(argument) = args.next() {
        let value = args.next().ok_or_else(|| {
            LoaderError(format!(
                "Missing value after {}",
                argument.to_string_lossy()
            ))
        })?;
        match argument.to_str() {
            Some("--socket") => socket_path = Some(PathBuf::from(value)),
            Some("--addon") => addon_path = Some(PathBuf::from(value)),
            Some("--addon-id") => expected_id = Some(value.to_string_lossy().into_owned()),
            Some("--version") => expected_version = Some(value.to_string_lossy().into_owned()),
            Some("--receipt") => receipt_path = Some(PathBuf::from(value)),
            Some("--timeout-seconds") => {
                let seconds = value.to_string_lossy().parse::<u64>()?;
                if !(1..=300).contains(&seconds) {
                    return Err(Box::new(LoaderError(
                        "--timeout-seconds must be between 1 and 300".to_owned(),
                    )));
                }
                timeout = Duration::from_secs(seconds);
            }
            Some(unknown) => {
                return Err(Box::new(LoaderError(format!(
                    "Unknown argument: {unknown}"
                ))));
            }
            None => {
                return Err(Box::new(LoaderError(
                    "Arguments must be valid UTF-8 option names".to_owned(),
                )));
            }
        }
    }

    Ok(Config {
        socket_path: required(socket_path, "--socket")?,
        addon_path: required(addon_path, "--addon")?,
        expected_id: required(expected_id, "--addon-id")?,
        expected_version: required(expected_version, "--version")?,
        receipt_path,
        timeout,
    })
}

fn required<T>(value: Option<T>, name: &str) -> Result<T, Box<dyn Error>> {
    value.ok_or_else(|| Box::<dyn Error>::from(LoaderError(format!("Missing {name}"))))
}

fn manifest_identity(config: &Config) -> Result<ManifestIdentity, Box<dyn Error>> {
    let addon_path = config.addon_path.canonicalize()?;
    if !addon_path.is_dir() {
        return Err(Box::new(LoaderError(format!(
            "Add-on path is not a directory: {}",
            addon_path.display()
        ))));
    }
    let manifest: Value = serde_json::from_slice(&fs::read(addon_path.join("manifest.json"))?)?;
    let addon_id = manifest
        .pointer("/browser_specific_settings/gecko/id")
        .and_then(Value::as_str)
        .ok_or_else(|| LoaderError("manifest.json has no Firefox add-on ID".to_owned()))?;
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| LoaderError("manifest.json has no version".to_owned()))?;
    if addon_id != config.expected_id {
        return Err(Box::new(LoaderError(format!(
            "Add-on ID mismatch: expected {}, found {addon_id}",
            config.expected_id
        ))));
    }
    if version != config.expected_version {
        return Err(Box::new(LoaderError(format!(
            "Add-on version mismatch: expected {}, found {version}",
            config.expected_version
        ))));
    }
    Ok(ManifestIdentity {
        addon_id: addon_id.to_owned(),
        version: version.to_owned(),
        tree_sha256: hash_tree(&addon_path)?,
    })
}

fn hash_tree(root: &Path) -> Result<String, Box<dyn Error>> {
    let mut files = Vec::new();
    collect_files(root, root, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for relative in files {
        let bytes = fs::read(root.join(&relative))?;
        let path_bytes = relative.as_os_str().as_encoded_bytes();
        hasher.update(path_bytes.len().to_le_bytes());
        hasher.update(path_bytes);
        hasher.update(bytes.len().to_le_bytes());
        hasher.update(bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), Box<dyn Error>> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(Box::new(LoaderError(format!(
                "Add-on source contains a symlink: {}",
                entry.path().display()
            ))));
        }
        if file_type.is_dir() {
            collect_files(root, &entry.path(), files)?;
        } else if file_type.is_file() {
            files.push(entry.path().strip_prefix(root)?.to_path_buf());
        } else {
            return Err(Box::new(LoaderError(format!(
                "Add-on source contains an unsupported filesystem entry: {}",
                entry.path().display()
            ))));
        }
    }
    Ok(())
}

fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Map<String, Value> {
    fields
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

fn install(config: &Config, identity: &ManifestIdentity) -> Result<Value, Box<dyn Error>> {
    let addon_path = config.addon_path.canonicalize()?;
    let deadline = Instant::now()
        .checked_add(config.timeout)
        .ok_or_else(|| LoaderError("Development-loader timeout overflowed".to_owned()))?;
    let (mut connection, _greeting) = RdpConnection::connect_ready(&config.socket_path, deadline)?;
    let root = connection.request("root", "getRoot", Map::new())?;
    let addons_actor = root
        .get("addonsActor")
        .and_then(Value::as_str)
        .ok_or_else(|| LoaderError("Firefox did not expose the add-ons actor".to_owned()))?;
    let installed = connection.request(
        addons_actor,
        "installTemporaryAddon",
        object([
            (
                "addonPath",
                Value::String(addon_path.to_string_lossy().into_owned()),
            ),
            ("openDevTools", Value::Bool(false)),
        ]),
    )?;
    let installed_id = installed.pointer("/addon/id").and_then(Value::as_str);
    if installed_id != Some(identity.addon_id.as_str()) {
        return Err(Box::new(LoaderError(format!(
            "Firefox installed an unexpected add-on identity: {installed_id:?}"
        ))));
    }
    let listed = connection.request("root", "listAddons", Map::new())?;
    let addon = listed
        .get("addons")
        .and_then(Value::as_array)
        .and_then(|addons| {
            addons.iter().find(|addon| {
                addon.get("id").and_then(Value::as_str) == Some(identity.addon_id.as_str())
            })
        })
        .ok_or_else(|| LoaderError("Firefox did not list the installed add-on".to_owned()))?;
    if addon.get("temporarilyInstalled").and_then(Value::as_bool) == Some(false) {
        return Err(Box::new(LoaderError(
            "Firefox listed the development add-on as non-temporary".to_owned(),
        )));
    }
    Ok(json!({
        "schemaVersion": 1,
        "status": "installed_verified",
        "installedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
        "addonId": identity.addon_id,
        "version": identity.version,
        "sourceTreeSha256": identity.tree_sha256,
        "sourcePath": addon_path,
        "socketPath": config.socket_path,
        "temporary": true,
        "firefoxActor": addon.get("actor").and_then(Value::as_str),
        "firefoxName": addon.get("name").and_then(Value::as_str),
    }))
}

fn write_receipt(path: &Path, receipt: &Value) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| LoaderError("Receipt path needs a UTF-8 file name".to_owned()))?;
    let temporary = path.with_file_name(format!(".{file_name}.tmp-{}", std::process::id()));
    let mut file = File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, receipt)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn run() -> Result<Value, Box<dyn Error>> {
    let config = parse_args()?;
    let identity = manifest_identity(&config)?;
    let receipt = install(&config, &identity)?;
    if let Some(path) = &config.receipt_path {
        write_receipt(path, &receipt)?;
    }
    Ok(receipt)
}

fn main() {
    match run() {
        Ok(receipt) => println!("{receipt}"),
        Err(error) => {
            eprintln!("local-archive-firefox-dev-loader: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_FRAME_BYTES, RdpConnection, read_frame_from};
    use serde_json::json;
    use std::fs;
    use std::io::{Cursor, Write};
    use std::os::unix::net::UnixListener;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn reads_one_length_prefixed_json_frame() {
        let value = json!({"from":"root","applicationType":"browser"});
        let bytes = serde_json::to_vec(&value).expect("test value should serialize");
        let framed = [format!("{}:", bytes.len()).into_bytes(), bytes].concat();
        assert_eq!(
            read_frame_from(&mut Cursor::new(framed)).expect("valid test frame should parse"),
            value
        );
    }

    #[test]
    fn rejects_oversized_frames() {
        let framed = format!("{}:", MAX_FRAME_BYTES + 1).into_bytes();
        assert!(read_frame_from(&mut Cursor::new(framed)).is_err());
    }

    #[test]
    fn waits_for_a_ready_rdp_greeting_after_the_socket_appears() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let socket_path = std::env::temp_dir().join(format!(
            "local-archive-loader-test-{}-{nonce}.sock",
            std::process::id()
        ));
        let listener = UnixListener::bind(&socket_path).expect("test socket should bind");
        let server = thread::spawn(move || {
            let (first, _) = listener.accept().expect("first test client should connect");
            thread::sleep(Duration::from_millis(650));
            drop(first);
            let (mut second, _) = listener
                .accept()
                .expect("retrying test client should connect");
            let greeting = serde_json::to_vec(&json!({
                "from": "root",
                "applicationType": "browser"
            }))
            .expect("test greeting should serialize");
            write!(second, "{}:", greeting.len()).expect("test frame length should write");
            second
                .write_all(&greeting)
                .expect("test greeting should write");
        });
        let deadline = Instant::now()
            .checked_add(Duration::from_secs(3))
            .expect("test deadline should fit");
        let (connection, greeting) = RdpConnection::connect_ready(&socket_path, deadline)
            .expect("loader should retry until the RDP greeting is ready");
        assert_eq!(
            greeting.get("from").and_then(serde_json::Value::as_str),
            Some("root")
        );
        drop(connection);
        server.join().expect("test RDP server should finish");
        fs::remove_file(socket_path).expect("test socket should be removable");
    }
}
