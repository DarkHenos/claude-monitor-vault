package com.alexossart.claudemonitorvault

import com.google.gson.JsonObject
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.ex.ToolWindowManagerListener
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.Cursor
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JComponent

internal object Icons {
    val monitor = IconLoader.getIcon("/icons/monitor.svg", Icons::class.java)
}

// The side panel: the extension's main webview (quotas, ChatGPT / Codex,
// secrets), in a tool window docked on the right like VS Code's secondary side
// bar. The user can move it to any side; nothing in the extension depends on it.
class PanelToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        try {
            build(project, toolWindow)
        } catch (e: Throwable) {
            // An empty tool window says nothing; the reason, shown in place,
            // is what a bug report needs.
            Plugin.LOG.warn("the panel could not be built", e)
            val label = JBLabel("<html>" + com.intellij.openapi.util.text.StringUtil.escapeXmlEntities(
                Plugin.NOTIFICATIONS + ": " + e) + "</html>")
            label.border = JBUI.Borders.empty(12)
            toolWindow.contentManager.removeAllContents(true)
            toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(label, "", false))
        }
    }

    private fun build(project: Project, toolWindow: ToolWindow) {
        val host = NodeHost.get(project)
        val view = WebviewBrowser(host.webviews.model(Plugin.VIEW_ID, false), toolWindow.disposable)
        val content = ContentFactory.getInstance().createContent(view.component, "", false)
        content.isCloseable = false
        toolWindow.contentManager.addContent(content)
        // A tool window left open is drawn before the startup activity runs.
        Commands.register()
        val am = ActionManager.getInstance()
        toolWindow.setTitleActions(listOfNotNull(
            am.getAction(Commands.actionId("claudeLimits.refresh")),
            am.getAction(Commands.actionId("claudeVault.settings"))))
        Ide.updateToolWindowTitle(project, host.webviews.viewDescription)

        var shown = toolWindow.isVisible
        host.webviews.setVisible(Plugin.VIEW_ID, shown)
        project.messageBus.connect(toolWindow.disposable).subscribe(ToolWindowManagerListener.TOPIC,
            object : ToolWindowManagerListener {
                override fun stateChanged(toolWindowManager: ToolWindowManager) {
                    val now = toolWindow.isVisible
                    if (now != shown) {
                        shown = now
                        host.webviews.setVisible(Plugin.VIEW_ID, now)
                    }
                }
            })
        host.webviews.attachView()
    }

    override fun shouldBeAvailable(project: Project) = true
}

// The status bar items the extension creates, by id. VS Code lays them out
// itself; here one widget shows them, side by side.
class StatusModel {
    private val items = LinkedHashMap<String, JsonObject>()
    private val listeners = ArrayList<() -> Unit>()

    val visible: List<JsonObject> get() = items.values.filter { it.bool("visible") }

    fun update(p: JsonObject) {
        val id = p.str("id") ?: return
        items[id] = p
        fire()
    }

    fun remove(p: JsonObject) {
        items.remove(p.str("id") ?: return)
        fire()
    }

    fun clear() {
        items.clear()
        fire()
    }

    fun listen(l: () -> Unit): () -> Unit {
        listeners.add(l)
        return { listeners.remove(l) }
    }

    private fun fire() {
        for (l in listeners.toList()) l()
    }
}

class StatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = "ClaudeMonitorVault.Status"
    override fun getDisplayName() = Plugin.NOTIFICATIONS
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = StatusWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) { widget.dispose() }
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

class StatusWidget(private val project: Project) : CustomStatusBarWidget {
    private val label = JBLabel(Icons.monitor)
    private var command: String? = null
    private val unlisten: () -> Unit

    init {
        label.border = JBUI.Borders.empty(0, 6)
        label.iconTextGap = JBUI.scale(4)
        label.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        label.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val c = command
                if (c != null) NodeHost.get(project).executeCommand(c)
                else ToolWindowManager.getInstance(project).getToolWindow(Plugin.TOOL_WINDOW)?.activate(null)
            }
        })
        unlisten = NodeHost.get(project).status.listen { refresh() }
        refresh()
    }

    private fun refresh() {
        val items = NodeHost.get(project).status.visible
        val first = items.firstOrNull()
        label.text = if (items.isEmpty()) "Claude …" else items.joinToString("  ") { it.str("text") ?: "" }
        label.toolTipText = first?.str("tooltip")?.let { "<html>$it</html>" } ?: Plugin.NOTIFICATIONS
        command = first?.str("command")
        val bg = Theme.color(first?.str("background"))
        val fg = Theme.color(first?.str("color"))
        label.isOpaque = bg != null
        label.background = bg
        label.foreground = fg ?: com.intellij.util.ui.UIUtil.getLabelForeground()
        label.revalidate()
        label.repaint()
    }

    override fun ID() = "ClaudeMonitorVault.Status"
    override fun getComponent(): JComponent = label
    override fun install(statusBar: StatusBar) {}
    override fun dispose() { unlisten() }
}
