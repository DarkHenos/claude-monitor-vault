package com.alexossart.claudemonitorvault

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.DumbAware

// The command palette of VS Code is Find Action here (Ctrl+Shift+A, or Shift
// twice). Every command the extension declares in package.json becomes an
// action, titled the way the palette titles it ("Claude Vault: Add a key"),
// and is also listed under Tools.
internal object Commands {
    private const val PREFIX = "ClaudeMonitorVault."
    const val GROUP = "ClaudeMonitorVault.Menu"

    fun actionId(command: String) = PREFIX + command

    // Which VS Code side bar holds the panel: a tool window is moved by
    // dragging it, so these two have nothing to do here.
    private val SKIP = setOf("claudeLimits.moveToSecondary", "claudeLimits.moveToPrimary")

    private val ICONS = mapOf(
        "\$(refresh)" to AllIcons.Actions.Refresh,
        "\$(gear)" to AllIcons.General.Settings,
        "\$(add)" to AllIcons.General.Add,
        "\$(lock)" to AllIcons.Nodes.Padlock,
        "\$(terminal)" to AllIcons.Debugger.Console
    )

    @Volatile private var registered = false

    fun register() {
        synchronized(this) {
            if (registered) return
            registered = true
        }
        val am = ActionManager.getInstance()
        val group = am.getAction(GROUP) as? DefaultActionGroup
        val plugin = PluginId.getId(Plugin.ID)
        for (c in Plugin.manifest.obj("contributes")?.arr("commands") ?: return) {
            val o = c.asJsonObject
            val command = o.str("command") ?: continue
            if (command in SKIP || am.getAction(actionId(command)) != null) continue
            val title = Plugin.nls(o.str("title"))
            val category = Plugin.nls(o.str("category"))
            val action = CommandAction(command, if (category.isNotBlank()) "$category: $title" else title)
            ICONS[o.str("icon")]?.let { action.templatePresentation.icon = it }
            am.registerAction(actionId(command), action, plugin)
            group?.add(action)
        }
    }
}

class CommandAction(private val command: String, text: String) : AnAction(text), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        NodeHost.get(project).executeCommand(command)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun getActionUpdateThread() = ActionUpdateThread.BGT
}
