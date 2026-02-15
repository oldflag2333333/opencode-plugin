import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export const Notify = async ({ client, directory }) => {
  const linuxIconPath = new URL("./opencode-notify-icon.svg", import.meta.url).pathname

  const DEFAULT_CONFIG = {
    suppressWhenFocused: true,
    notifyOnError: true,
    notifyOnPermission: true,
    notifyOnQuestion: true,
    notifyChildSessions: false,
  }

  const configPath = path.join(os.homedir(), ".config", "opencode", "plugins", "notify-config.json")
  let config = DEFAULT_CONFIG

  try {
    const configContent = fs.readFileSync(configPath, "utf-8")
    const userConfig = JSON.parse(configContent)
    config = { ...DEFAULT_CONFIG, ...userConfig }
  } catch {
    // Use defaults if file doesn't exist or is invalid
  }

  const KNOWN_TERMINAL_EXACT = new Set([
    "ghostty",
    "kitty",
    "foot",
    "alacritty",
    "wezterm",
    "iterm2",
    "terminal",
    "hyper",
    "warp",
    "rio",
    "st",
    "urxvt",
    "xterm",
    "com.mitchellh.ghostty",
    "org.wezfurlong.wezterm",
    "org.alacritty.alacritty",
    "dev.warp.warp",
    "net.kovidgoyal.kitty",
  ])

  const KNOWN_TERMINAL_TOKENS = new Set([
    "ghostty",
    "kitty",
    "foot",
    "alacritty",
    "wezterm",
    "iterm2",
    "terminal",
    "hyper",
    "warp",
    "rio",
    "urxvt",
    "xterm",
  ])

  const isKnownTerminalIdentifier = (value) => {
    if (typeof value !== "string") return false
    const normalized = value.trim().toLowerCase()
    if (!normalized) return false
    if (KNOWN_TERMINAL_EXACT.has(normalized)) return true

    const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean)
    return parts.some((part) => KNOWN_TERMINAL_TOKENS.has(part))
  }

  const pickFocusedKittyWindowID = (payload) => {
    if (!Array.isArray(payload)) return undefined

    for (const osWindow of payload) {
      const tabs = Array.isArray(osWindow?.tabs) ? osWindow.tabs : []
      for (const tab of tabs) {
        const windows = Array.isArray(tab?.windows) ? tab.windows : []
        for (const window of windows) {
          const id = window?.id
          if (id === undefined || id === null) continue
          const focused = window?.is_focused === true || window?.focused === true || window?.is_active === true
          if (focused) return String(id)
        }
      }
    }

    for (const osWindow of payload) {
      const tabs = Array.isArray(osWindow?.tabs) ? osWindow.tabs : []
      for (const tab of tabs) {
        const windows = Array.isArray(tab?.windows) ? tab.windows : []
        for (const window of windows) {
          const id = window?.id
          if (id !== undefined && id !== null) return String(id)
        }
      }
    }

    return undefined
  }

  const isCurrentKittyWindowFocused = async () => {
    const currentWindowID = process.env.KITTY_WINDOW_ID
    if (!currentWindowID) return undefined

    try {
      const proc = Bun.spawn(["kitty", "@", "ls", "--match", "state:focused", "--output-format", "json"], {
        stdout: "pipe",
        stderr: "ignore",
      })
      const text = await new Response(proc.stdout).text()
      if (!text.trim()) return undefined

      const payload = JSON.parse(text)
      const focusedWindowID = pickFocusedKittyWindowID(payload)
      if (!focusedWindowID) return undefined

      return focusedWindowID === String(currentWindowID)
    } catch {
      return undefined
    }
  }

  const markKittyTabNeedsInput = () => {
    if (!process.env.KITTY_WINDOW_ID) return
    process.stdout.write("\x07")
  }

  const pickSessionLabel = (session, sessionID) => {
    if (!session || typeof session !== "object") return sessionID
    const title = typeof session.title === "string" ? session.title.trim() : ""
    const slug = typeof session.slug === "string" ? session.slug.trim() : ""
    const id = typeof session.id === "string" ? session.id.trim() : ""
    return title || slug || id || sessionID
  }

  const unwrapData = (result) => {
    if (!result || typeof result !== "object") return undefined
    return result.data
  }

  const getSessionByID = async (sessionID) => {
    try {
      const result = await client.session.get({ sessionID, directory })
      const session = unwrapData(result)
      if (session) return session
    } catch (error) {
      void error
    }

    try {
      const result = await client.session.get({ sessionID })
      const session = unwrapData(result)
      if (session) return session
    } catch (error) {
      void error
    }

    try {
      const result = await client.session.list({ directory, limit: 100 })
      const sessions = unwrapData(result)
      if (Array.isArray(sessions)) {
        const matched = sessions.find((item) => item?.id === sessionID)
        if (matched) return matched
      }
    } catch (error) {
      void error
    }

    return undefined
  }

  /**
   * Checks whether the currently focused window is a terminal emulator.
   *
   * Detection chain:
   *   1. Hyprland (HYPRLAND_INSTANCE_SIGNATURE) -> hyprctl -j activewindow -> .class
   *   2. Niri (NIRI_SOCKET) -> niri msg --json focused-window -> .app_id
   *   3. macOS (process.platform === "darwin") -> osascript -> frontmost process name
   *   4. Fallback: return false (unknown compositor -> always notify)
   *
   * All shell commands use .nothrow() so the plugin never crashes if tools
   * are unavailable or return unexpected output.
   */
  const isTerminalFocused = async () => {
    // Hyprland
    if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
      try {
        const proc = Bun.spawn(["hyprctl", "-j", "activewindow"], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const text = await new Response(proc.stdout).text()
        const json = JSON.parse(text)
        // Hyprland returns {} on an empty workspace — .class will be undefined
        const cls = json?.class
        if (typeof cls === "string" && cls.length > 0) return isKnownTerminalIdentifier(cls)
        return false
      } catch {
        return false
      }
    }

    // Niri
    if (process.env.NIRI_SOCKET) {
      try {
        const proc = Bun.spawn(["niri", "msg", "--json", "focused-window"], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const text = await new Response(proc.stdout).text()
        const json = JSON.parse(text)
        // Niri returns null when nothing is focused
        if (json === null || json === undefined) return false
        const appId = json?.app_id
        if (typeof appId === "string" && appId.length > 0) return isKnownTerminalIdentifier(appId)
        return false
      } catch {
        return false
      }
    }

    // macOS
    if (process.platform === "darwin") {
      try {
        const proc = Bun.spawn(["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const text = await new Response(proc.stdout).text()
        const name = text.trim()
        if (name.length > 0) return isKnownTerminalIdentifier(name)
        return false
      } catch {
        return false
      }
    }

    // Unknown compositor / platform — always notify
    return false
  }

  const sendOsNotification = async (title, message) => {
    if (process.platform === "linux") {
      const proc = Bun.spawn(["notify-send", "-a", "OpenCode", "-h", "string:desktop-entry:opencode", "-i", linuxIconPath, title, message], {
        stdout: "ignore",
        stderr: "ignore",
      })
      await proc.exited
      return
    }

    if (process.platform === "darwin") {
      const escapeAppleScriptString = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
      const escapedTitle = escapeAppleScriptString(title)
      const escapedMessage = escapeAppleScriptString(message)
      const script = `display notification "${escapedMessage}" with title "${escapedTitle}"`
      const proc = Bun.spawn(["osascript", "-e", script], {
        stdout: "ignore",
        stderr: "ignore",
      })
      await proc.exited
    }
  }

  /**
   * Orchestrates notification delivery:
   *   1. Check terminal focus (if config.suppressWhenFocused is true)
   *   2. Show TUI toast (always)
   *   3. Send desktop notification (unless suppressed by focus)
   *   4. Fire Kitty bell (always)
   *
   * @param {object} opts
   * @param {string} opts.title - Notification title
   * @param {string} opts.message - Notification body
   * @param {"info"|"success"|"warning"|"error"} opts.variant - TUI toast variant
   * @param {object} opts.config - Configuration object
   */
  const sendNotification = async ({ title, message, variant, config }) => {
    let suppressWhileFocused = false
    const shouldShowToast = variant === "error"

    if (config.suppressWhenFocused && variant !== "error") {
      const terminalFocused = await isTerminalFocused()

      if (!terminalFocused) {
        suppressWhileFocused = false
      } else if (process.platform === "linux" && process.env.KITTY_WINDOW_ID) {
        const sameKittyWindowFocused = await isCurrentKittyWindowFocused()
        if (sameKittyWindowFocused === true) {
          suppressWhileFocused = true
        } else if (sameKittyWindowFocused === false) {
          suppressWhileFocused = false
        } else {
          suppressWhileFocused = terminalFocused
        }
      } else {
        suppressWhileFocused = terminalFocused
      }
    }

    if (suppressWhileFocused) return

    if (shouldShowToast) {
      try {
        await client.tui.showToast({ directory, title, message, variant })
      } catch (error) {
        void error
      }
    }

    if (!suppressWhileFocused || variant === "error") {
      try {
        await sendOsNotification(title, message)
      } catch (error) {
        void error
      }
    }

    try {
      markKittyTabNeedsInput()
    } catch (error) {
      void error
    }
  }

  const handlePermissionEvent = async (event, config) => {
    if (!config.notifyOnPermission) return

    const { sessionID } = event.properties
    const session = await getSessionByID(sessionID)
    if (!session) return
    if (!config.notifyChildSessions && session.parentID) return

    const sessionLabel = pickSessionLabel(session, sessionID)

    // v1: permission.updated uses .title field
    // v2: permission.asked uses .permission field
    const permissionDescription =
      typeof event.properties.title === "string" ? event.properties.title
      : typeof event.properties.permission === "string" ? event.properties.permission
      : "Permission needed"

    await sendNotification({
      title: "Permission needed",
      message: sessionLabel + ": " + permissionDescription,
      variant: "warning",
      config,
    })
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const { sessionID } = event.properties
        const session = await getSessionByID(sessionID)
        if (!session) return
        if (!config.notifyChildSessions && session.parentID) return

        const sessionLabel = pickSessionLabel(session, sessionID)

        await sendNotification({
          title: "Agent is ready for input",
          message: sessionLabel,
          variant: "info",
          config,
        })
      } else if (event.type === "session.error") {
        if (!config.notifyOnError) return

        const { sessionID, error } = event.properties

        // Skip notification for user-initiated aborts
        if (error?.type === "aborted") return

        let sessionLabel = "Unknown session"
        if (sessionID) {
          const session = await getSessionByID(sessionID)
          // Filter out child sessions (only notify for parent sessions)
          if (!config.notifyChildSessions && session?.parentID) return
          sessionLabel = pickSessionLabel(session, sessionID)
        }

        // Extract error message based on error type
        let errorMessage = "Something went wrong"
        if (error?.type === "provider_auth") {
          errorMessage = "Auth error: " + (error.data?.message || "")
        } else if (error?.type === "unknown") {
          errorMessage = error.data?.message || "Unknown error"
        } else if (error?.type === "output_length") {
          errorMessage = "Output too long"
        } else if (error?.type === "api") {
          errorMessage = "API error: " + (error.data?.message || "")
        }

        // Truncate message to 100 characters
        const fullMessage = sessionLabel + ": " + errorMessage
        const truncatedMessage = fullMessage.length > 100 ? fullMessage.slice(0, 97) + "..." : fullMessage

        await sendNotification({
          title: "Error occurred",
          message: truncatedMessage,
          variant: "error",
          config,
        })
      } else if (event.type === "question.asked") {
        if (!config.notifyOnQuestion) return

        const { sessionID } = event.properties
        const session = await getSessionByID(sessionID)
        if (!session) return
        if (!config.notifyChildSessions && session.parentID) return

        const sessionLabel = pickSessionLabel(session, sessionID)

        await sendNotification({
          title: "Question for you",
          message: sessionLabel,
          variant: "warning",
          config,
        })
      } else if (event.type === "permission.updated") {
        await handlePermissionEvent(event, config)
      } else if (event.type === "permission.asked") {
        await handlePermissionEvent(event, config)
      }
    },
  }
}
