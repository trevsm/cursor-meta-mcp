import AppKit
import WebKit

private let watcherLabel = "com.cursor-meta.atlas-archive"
private let serverLabel = "com.cursor-meta.atlas-server"
private let home = FileManager.default.homeDirectoryForCurrentUser
private let logDir = home.appendingPathComponent(".cursor-meta/logs")
private let errLog = logDir.appendingPathComponent("atlas-archive.err.log")
private let configPath = home.appendingPathComponent(".cursor-meta/atlas-app.json")
private let iconsDir = home.appendingPathComponent(".cursor-meta/icons")

private struct AtlasConfig: Codable {
  let port: Int
  let baseUrl: String
}

private func loadConfig() -> AtlasConfig {
  if let data = try? Data(contentsOf: configPath),
     let cfg = try? JSONDecoder().decode(AtlasConfig.self, from: data) {
    return cfg
  }
  return AtlasConfig(port: 3847, baseUrl: "http://127.0.0.1:3847")
}

private let appName = "Conversation Atlas"

final class AtlasAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var config = loadConfig()
  private var statusItem: NSStatusItem!
  private var window: NSWindow!
  private var webView: WKWebView!
  private var statusTimer: Timer?
  private var serverTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    setupMainMenu()
    setupWindow()
    setupStatusItem()
    updateArchiveStatus()
    statusTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.updateArchiveStatus()
    }
    waitForServerAndLoad()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  private func setupMainMenu() {
    let mainMenu = NSMenu()

    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "About \(appName)", action: #selector(showAbout), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Show \(appName)", action: #selector(showWindow), keyEquivalent: "0")
    appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = appMenu.addItem(
      withTitle: "Hide Others",
      action: #selector(NSApplication.hideOtherApplications(_:)),
      keyEquivalent: "h"
    )
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(
      withTitle: "Show All",
      action: #selector(NSApplication.unhideAllApplications(_:)),
      keyEquivalent: ""
    )
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Quit \(appName)",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q"
    )

    let appMenuItem = NSMenuItem()
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    let editMenuItem = NSMenuItem()
    editMenuItem.submenu = editMenu
    mainMenu.addItem(editMenuItem)

    let viewMenu = NSMenu(title: "View")
    viewMenu.addItem(withTitle: "Reload", action: #selector(reloadWebView), keyEquivalent: "r")
    let viewMenuItem = NSMenuItem()
    viewMenuItem.submenu = viewMenu
    mainMenu.addItem(viewMenuItem)

    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
    windowMenu.addItem(.separator())
    windowMenu.addItem(
      withTitle: "Bring All to Front",
      action: #selector(NSApplication.arrangeInFront(_:)),
      keyEquivalent: ""
    )
    let windowMenuItem = NSMenuItem()
    windowMenuItem.submenu = windowMenu
    mainMenu.addItem(windowMenuItem)
    NSApp.windowsMenu = windowMenu

    for item in appMenu.items + viewMenu.items where item.action != nil {
      item.target = self
    }
    for item in [hideOthers] {
      item.target = NSApp
    }
    for item in appMenu.items where item.action == #selector(NSApplication.hide(_:))
      || item.action == #selector(NSApplication.unhideAllApplications(_:))
      || item.action == #selector(NSApplication.terminate(_:)) {
      item.target = NSApp
    }
    for item in windowMenu.items where item.action != nil {
      item.target = item.action == #selector(NSApplication.arrangeInFront(_:)) ? NSApp : nil
    }

    NSApp.mainMenu = mainMenu
  }

  private func setupWindow() {
    let rect = NSRect(x: 0, y: 0, width: 1280, height: 860)
    window = NSWindow(
      contentRect: rect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Conversation Atlas"
    window.center()
    window.minSize = NSSize(width: 900, height: 600)
    window.delegate = self
    window.isReleasedWhenClosed = false

    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    webView = WKWebView(frame: rect, configuration: config)
    webView.autoresizingMask = [.width, .height]
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func setupStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    rebuildMenu()
  }

  private func waitForServerAndLoad() {
    serverTimer?.invalidate()
    var attempts = 0
    serverTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
      guard let self else { return }
      attempts += 1
      self.checkServer { ready in
        DispatchQueue.main.async {
          if ready {
            timer.invalidate()
            self.serverTimer = nil
            if let url = URL(string: self.config.baseUrl) {
              self.webView.load(URLRequest(url: url))
            }
          } else if attempts > 60 {
            timer.invalidate()
            self.serverTimer = nil
            self.loadOfflinePlaceholder()
          }
        }
      }
    }
  }

  private func checkServer(completion: @escaping (Bool) -> Void) {
    guard let url = URL(string: "\(config.baseUrl)/api/atlas/health") else {
      completion(false)
      return
    }
    URLSession.shared.dataTask(with: url) { _, response, _ in
      completion((response as? HTTPURLResponse)?.statusCode == 200)
    }.resume()
  }

  private func loadOfflinePlaceholder() {
    let html = """
    <html><body style="background:#0f1117;color:#e6e6e6;font:16px -apple-system,sans-serif;padding:48px">
    <h2>Conversation Atlas server is starting…</h2>
    <p>If this persists, check <code>~/.cursor-meta/logs/atlas-server.err.log</code></p>
    </body></html>
    """
    webView.loadHTMLString(html, baseURL: nil)
  }

  private func watcherRunning() -> Bool {
    serviceRunning(label: watcherLabel)
  }

  private func serviceRunning(label: String) -> Bool {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = ["print", "gui/\(getuid())/\(label)"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
      try task.run()
      task.waitUntilExit()
      let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      return out.contains("state = running")
    } catch {
      return false
    }
  }

  private func rasterizeTemplateIcon(from source: NSImage, size: CGFloat) -> NSImage {
    let target = NSSize(width: size, height: size)
    let image = NSImage(size: target)
    image.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    source.draw(in: NSRect(origin: .zero, size: target), from: .zero, operation: .sourceOver, fraction: 1)
    image.unlockFocus()
    image.isTemplate = true
    return image
  }

  private func makeStatusIcon(active: Bool) -> NSImage? {
    let svgName = active ? "menubar-active.svg" : "menubar-idle.svg"
    let svgPath = iconsDir.appendingPathComponent(svgName)
    if let svg = NSImage(contentsOf: svgPath) {
      return rasterizeTemplateIcon(from: svg, size: 18)
    }
    return loadIcon(
      named: active ? "menubar-active.png" : "menubar-idle.png",
      template: true,
      size: 18
    )
  }

  private func loadIcon(named: String, template: Bool, size: CGFloat) -> NSImage? {
    let path = iconsDir.appendingPathComponent(named)
    guard let image = NSImage(contentsOf: path) else { return nil }
    image.isTemplate = template
    image.size = NSSize(width: size, height: size)
    return image
  }

  private func lastLogLine() -> String {
    guard let text = try? String(contentsOf: errLog, encoding: .utf8) else {
      return "No archive log yet"
    }
    return text.split(separator: "\n", omittingEmptySubsequences: true).last.map(String.init) ?? "No archive log yet"
  }

  private func updateArchiveStatus() {
    let capturing = watcherRunning()
    if let icon = makeStatusIcon(active: capturing) {
      statusItem.button?.image = icon
      statusItem.button?.title = ""
    } else {
      statusItem.button?.image = nil
      statusItem.button?.title = capturing ? "◈" : "◇"
    }
    statusItem.button?.toolTip = capturing
      ? "Conversation Atlas · archive capturing"
      : "Conversation Atlas · archive stopped"
    rebuildMenu()
  }

  private func rebuildMenu() {
    let menu = NSMenu()
    let capturing = watcherRunning()
    let status = NSMenuItem(
      title: capturing ? "Archive · capturing" : "Archive · stopped",
      action: nil,
      keyEquivalent: ""
    )
    status.isEnabled = false
    menu.addItem(status)
    let logLine = NSMenuItem(title: lastLogLine(), action: nil, keyEquivalent: "")
    logLine.isEnabled = false
    menu.addItem(logLine)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Show Atlas", action: #selector(showWindow), keyEquivalent: "a"))
    menu.addItem(NSMenuItem(title: "Hide Atlas", action: #selector(hideWindow), keyEquivalent: "h"))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Reload", action: #selector(reloadWebView), keyEquivalent: "r"))
    menu.addItem(NSMenuItem(title: "Open archive log", action: #selector(openLog), keyEquivalent: "l"))
    menu.addItem(.separator())
    menu.addItem(
      NSMenuItem(title: "Restart archive watcher", action: #selector(restartWatcher), keyEquivalent: "")
    )
    menu.addItem(
      NSMenuItem(title: "Restart Atlas server", action: #selector(restartServer), keyEquivalent: "")
    )
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit Conversation Atlas", action: #selector(quitApp), keyEquivalent: "q"))
    for item in menu.items where item.action != nil {
      item.target = self
    }
    statusItem.menu = menu
  }

  @objc private func showAbout() {
    NSApp.orderFrontStandardAboutPanel(options: [
      NSApplication.AboutPanelOptionKey.applicationName: appName,
      NSApplication.AboutPanelOptionKey(rawValue: "Copyright"): "Conversation Atlas",
    ])
  }

  @objc private func toggleWindow() {
    if window.isVisible {
      hideWindow()
    } else {
      showWindow()
    }
  }

  @objc private func showWindow() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc private func hideWindow() {
    window.orderOut(nil)
  }

  @objc private func reloadWebView() {
    if webView.url != nil {
      webView.reload()
    } else {
      waitForServerAndLoad()
    }
  }

  @objc private func openLog() {
    NSWorkspace.shared.open(errLog)
  }

  @objc private func restartWatcher() {
    kickstart(label: watcherLabel)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.updateArchiveStatus() }
  }

  @objc private func restartServer() {
    kickstart(label: serverLabel)
    waitForServerAndLoad()
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }

  private func kickstart(label: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(label)"]
    try? task.run()
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    hideWindow()
    return false
  }
}

let app = NSApplication.shared
let delegate = AtlasAppDelegate()
app.delegate = delegate
app.run()
