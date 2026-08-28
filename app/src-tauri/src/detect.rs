//! Environment detection.
//!
//! Every check here exists because it cost real time to diagnose by hand on
//! 2026-08-27. The installer's value is that nobody has to repeat that.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// How Claude Desktop was installed. This is the single most important thing to
/// get right on Windows.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopKind {
    /// Microsoft Store / MSIX. Virtualizes %APPDATA%, so `${__dirname}` is handed
    /// to the spawned MCP server as a path that only resolves *inside* the app
    /// container. Child processes run outside it, so the server dies instantly
    /// with MODULE_NOT_FOUND, surfacing as "Server disconnected".
    /// Upstream: anthropics/claude-code#47977.
    Msix,
    /// Direct download / normal install. No virtualization.
    Standard,
    NotInstalled,
}

#[derive(Serialize, Debug)]
pub struct Detection {
    pub desktop: DesktopKind,
    /// Where extensions actually land on disk (the real path, not the virtual one).
    pub extensions_dir: Option<PathBuf>,
    /// True when the MSIX write-through fix is needed and not yet applied.
    pub needs_msix_fix: bool,
    pub node: Option<String>,
    pub node_on_path: bool,
    pub cursor_installed: bool,
    pub claude_code_installed: bool,
    /// Claude Desktop processes currently running. Installing while these are
    /// alive means the change won't be picked up, and on Windows a closed window
    /// still leaves one running.
    pub running_desktop_procs: usize,
}

const MSIX_PACKAGE: &str = "Claude_pzs8sxrjxfjjc";

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Detect how Claude Desktop is installed and where its extensions really live.
#[cfg(target_os = "windows")]
fn detect_desktop() -> (DesktopKind, Option<PathBuf>) {
    let local = dirs::data_local_dir().unwrap_or_else(|| home().join("AppData/Local"));
    let msix_root = local.join("Packages").join(MSIX_PACKAGE);

    if msix_root.is_dir() {
        // The physical location. NOT %APPDATA%\Claude, which is what the app
        // reports and what every doc tells you to look at.
        let real = msix_root.join("LocalCache/Roaming/Claude/Claude Extensions");
        return (DesktopKind::Msix, Some(real));
    }

    let roaming = dirs::config_dir().unwrap_or_else(|| home().join("AppData/Roaming"));
    let claude = roaming.join("Claude");
    if claude.is_dir() {
        (DesktopKind::Standard, Some(claude.join("Claude Extensions")))
    } else {
        (DesktopKind::NotInstalled, None)
    }
}

#[cfg(target_os = "macos")]
fn detect_desktop() -> (DesktopKind, Option<PathBuf>) {
    if !Path::new("/Applications/Claude.app").is_dir()
        && !home().join("Applications/Claude.app").is_dir()
    {
        return (DesktopKind::NotInstalled, None);
    }
    let dir = home().join("Library/Application Support/Claude/Claude Extensions");
    (DesktopKind::Standard, Some(dir))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn detect_desktop() -> (DesktopKind, Option<PathBuf>) {
    (DesktopKind::NotInstalled, None)
}

/// Whether the MSIX write-through workaround still needs applying.
///
/// Pre-creating the *real* `%APPDATA%\Claude\Claude Extensions` before install
/// stops MSIX from virtualizing that path, so the spawned server gets a path it
/// can actually resolve. Only meaningful on the Store build.
#[cfg(target_os = "windows")]
fn msix_fix_needed(kind: &DesktopKind) -> bool {
    if *kind != DesktopKind::Msix {
        return false;
    }
    let roaming = dirs::config_dir().unwrap_or_else(|| home().join("AppData/Roaming"));
    !roaming.join("Claude/Claude Extensions").is_dir()
}

#[cfg(not(target_os = "windows"))]
fn msix_fix_needed(_kind: &DesktopKind) -> bool {
    false
}

/// Find node, preferring PATH but falling back to well-known install locations.
///
/// PATH alone is not enough: Windows fixes a process's PATH at launch, so a Node
/// installed after Claude Desktop started is invisible to it — and to us, if we
/// were launched from a stale shell.
fn detect_node() -> (Option<String>, bool) {
    let on_path = which::which("node").ok();
    if let Some(p) = &on_path {
        if let Some(v) = node_version(p) {
            return (Some(v), true);
        }
    }

    let candidates: Vec<PathBuf> = if cfg!(target_os = "windows") {
        vec![
            PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/bin/node"),
        ]
    };

    for c in candidates {
        if c.is_file() {
            if let Some(v) = node_version(&c) {
                // Found, but not on PATH — Claude Desktop spawns `node` bare, so
                // it would still fail. The caller must surface this distinction.
                return (Some(v), false);
            }
        }
    }
    (None, false)
}

fn node_version(path: &Path) -> Option<String> {
    let out = std::process::Command::new(path).arg("--version").output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn count_desktop_processes() -> usize {
    let (cmd, args): (&str, Vec<&str>) = if cfg!(target_os = "windows") {
        ("tasklist", vec!["/FI", "IMAGENAME eq Claude.exe", "/NH"])
    } else {
        ("pgrep", vec!["-x", "Claude"])
    };
    std::process::Command::new(cmd)
        .args(args)
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| {
                    let l = l.trim();
                    !l.is_empty() && !l.starts_with("INFO:")
                })
                .count()
        })
        .unwrap_or(0)
}

fn cursor_installed() -> bool {
    if cfg!(target_os = "macos") {
        Path::new("/Applications/Cursor.app").is_dir() || home().join(".cursor").is_dir()
    } else {
        home().join(".cursor").is_dir()
            || dirs::data_local_dir()
                .map(|d| d.join("Programs/cursor").is_dir())
                .unwrap_or(false)
    }
}

pub fn detect() -> Detection {
    let (desktop, extensions_dir) = detect_desktop();
    let needs_msix_fix = msix_fix_needed(&desktop);
    let (node, node_on_path) = detect_node();

    Detection {
        desktop,
        extensions_dir,
        needs_msix_fix,
        node,
        node_on_path,
        cursor_installed: cursor_installed(),
        claude_code_installed: which::which("claude").is_ok(),
        running_desktop_procs: count_desktop_processes(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_runs_without_panicking() {
        let d = detect();
        // On a dev Mac we expect Claude Desktop present and node on PATH; the
        // point of the assertion is that every probe completes.
        assert!(matches!(
            d.desktop,
            DesktopKind::Standard | DesktopKind::Msix | DesktopKind::NotInstalled
        ));
    }

    #[test]
    fn msix_fix_never_applies_off_windows() {
        if !cfg!(target_os = "windows") {
            assert!(!detect().needs_msix_fix);
        }
    }

    #[test]
    fn node_reported_as_on_path_only_when_truly_on_path() {
        let d = detect();
        if d.node_on_path {
            assert!(d.node.is_some(), "claimed node on PATH but no version");
            assert!(which::which("node").is_ok());
        }
    }
}

#[cfg(test)]
mod smoke {
    /// Not an assertion — prints what detection actually sees on this machine.
    /// `cargo test -- --nocapture real_environment`
    #[test]
    fn real_environment() {
        println!("{}", serde_json::to_string_pretty(&super::detect()).unwrap());
    }
}
