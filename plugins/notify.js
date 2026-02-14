export const Notify = async ({ client, $, directory }) => {
  const linuxIconPath = new URL("./opencode-notify-icon.svg", import.meta.url).pathname

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

  const sendOsNotification = async (sessionLabel) => {
    if (process.platform === "linux") {
      await $`notify-send -a "OpenCode" -h "string:desktop-entry:opencode" "Agent is ready for input" "${sessionLabel}" -i ${linuxIconPath}`
      return
    }

    if (process.platform === "darwin") {
      await $`osascript -e 'display notification "${sessionLabel}" with title "Agent is ready for input"'`
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const { sessionID } = event.properties
      const session = await getSessionByID(sessionID)
      if (!session) return
      if (session.parentID) return

      const sessionLabel = pickSessionLabel(session, sessionID)

      const notificationTitle = "Agent is ready for input"
      const notificationMessage = sessionLabel

      try {
        await client.tui.showToast({ directory, title: notificationTitle, message: notificationMessage, variant: "info" })
      } catch (error) {
        void error
      }

      try {
        await sendOsNotification(sessionLabel)
      } catch (error) {
        void error
      }
    },
  }
}
