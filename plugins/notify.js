export const Notify = async ({ client, $, directory }) => {
  const linuxIconPath = new URL("./opencode-notify-icon.svg", import.meta.url).pathname

  // Known terminal emulator identifiers used for focus detection.
  // Lowercase entries cover Linux Wayland class names and app IDs.
  // macOS process names are matched case-insensitively via .toLowerCase().
  const KNOWN_TERMINALS = new Set([
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
  ])

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
        const result = await $`hyprctl -j activewindow`.nothrow()
        const json = JSON.parse(result.stdout.toString())
        // Hyprland returns {} on an empty workspace — .class will be undefined
        const cls = json?.class
        if (typeof cls === "string" && cls.length > 0) {
          return KNOWN_TERMINALS.has(cls.toLowerCase())
        }
        return false
      } catch {
        return false
      }
    }

    // Niri
    if (process.env.NIRI_SOCKET) {
      try {
        const result = await $`niri msg --json focused-window`.nothrow()
        const json = JSON.parse(result.stdout.toString())
        // Niri returns null when nothing is focused
        if (json === null || json === undefined) return false
        const appId = json?.app_id
        if (typeof appId === "string" && appId.length > 0) {
          return KNOWN_TERMINALS.has(appId.toLowerCase())
        }
        return false
      } catch {
        return false
      }
    }

    // macOS
    if (process.platform === "darwin") {
      try {
        const result =
          await $`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`.nothrow()
        const name = result.stdout.toString().trim()
        if (name.length > 0) {
          return KNOWN_TERMINALS.has(name.toLowerCase())
        }
        return false
      } catch {
        return false
      }
    }

    // Unknown compositor / platform — always notify
    return false
  }

  // NOTE: Bun's $ tagged template literal already escapes all interpolated
  // values, preventing shell injection attacks. The string interpolations
  // below (e.g. ${title}, ${message}) are safe by design — Bun automatically
  // quotes and escapes them before passing to the shell.
  // See: https://bun.sh/docs/runtime/shell
  const sendOsNotification = async (title, message) => {
    if (process.platform === "linux") {
      await $`notify-send -a "OpenCode" -h "string:desktop-entry:opencode" ${title} ${message} -i ${linuxIconPath}`.nothrow()
      return
    }

    if (process.platform === "darwin") {
      await $`osascript -e 'display notification "${message}" with title "${title}"'`.nothrow()
    }
  }

  /**
   * Orchestrates notification delivery:
   *   1. Check terminal focus (if skipDesktopIfFocused is true)
   *   2. Show TUI toast (always)
   *   3. Send desktop notification (unless suppressed by focus)
   *   4. Fire Kitty bell (always)
   *
   * @param {object} opts
   * @param {string} opts.title - Notification title
   * @param {string} opts.message - Notification body
   * @param {"info"|"success"|"warning"|"error"} opts.variant - TUI toast variant
   * @param {boolean} opts.skipDesktopIfFocused - If true, suppress desktop notification when terminal is focused
   */
  const sendNotification = async ({ title, message, variant, skipDesktopIfFocused }) => {
    const focused = skipDesktopIfFocused ? await isTerminalFocused() : false

    try {
      await client.tui.showToast({ directory, title, message, variant })
    } catch (error) {
      void error
    }

    if (!focused) {
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

  const handlePermissionEvent = async (event) => {
    const { sessionID } = event.properties
    const session = await getSessionByID(sessionID)
    if (!session) return
    if (session.parentID) return

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
      skipDesktopIfFocused: true,
    })
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const { sessionID } = event.properties
        const session = await getSessionByID(sessionID)
        if (!session) return
        if (session.parentID) return

        const sessionLabel = pickSessionLabel(session, sessionID)

        await sendNotification({
          title: "Agent is ready for input",
          message: sessionLabel,
          variant: "info",
          skipDesktopIfFocused: true,
        })
      } else if (event.type === "session.error") {
        const { sessionID, error } = event.properties

        // Skip notification for user-initiated aborts
        if (error?.type === "aborted") return

        let sessionLabel = "Unknown session"
        if (sessionID) {
          const session = await getSessionByID(sessionID)
          // Filter out child sessions (only notify for parent sessions)
          if (session?.parentID) return
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
          skipDesktopIfFocused: false,
        })
      } else if (event.type === "question.asked") {
        const { sessionID } = event.properties
        const session = await getSessionByID(sessionID)
        if (!session) return
        if (session.parentID) return

        const sessionLabel = pickSessionLabel(session, sessionID)

        await sendNotification({
          title: "Question for you",
          message: sessionLabel,
          variant: "warning",
          skipDesktopIfFocused: true,
        })
      } else if (event.type === "permission.updated") {
        await handlePermissionEvent(event)
      } else if (event.type === "permission.asked") {
        await handlePermissionEvent(event)
      }
    },
  }
}
