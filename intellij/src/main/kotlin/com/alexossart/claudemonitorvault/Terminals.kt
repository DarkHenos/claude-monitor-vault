package com.alexossart.claudemonitorvault

import com.google.gson.JsonObject
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentManagerEvent
import com.intellij.ui.content.ContentManagerListener
import org.jetbrains.plugins.terminal.LocalTerminalDirectRunner
import org.jetbrains.plugins.terminal.TerminalTabState
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

// createTerminal: a tab in the IDE's Terminal tool window. The tab runs the
// requested program itself (the assistant CLI, or the vault terminal through
// host/launch.js), never a command typed into the user's shell, so no quoting
// or shell syntax is involved.
internal class Terminals(private val host: NodeHost) {
    private val contents = HashMap<String, Content>()
    private var watching: ToolWindow? = null

    fun create(p: JsonObject) {
        val id = p.str("id") ?: return
        val name = p.str("name") ?: "Terminal"
        val manager = TerminalToolWindowManager.getInstance(host.project)
        val state = TerminalTabState()
        state.myTabName = name
        state.myIsUserDefinedTabTitle = true
        state.myWorkingDirectory = p.str("cwd") ?: host.project.basePath
        val command = p.get("command")?.takeIf { it.isJsonArray }?.asJsonArray?.map { it.asString }
        if (!command.isNullOrEmpty()) state.myShellCommand = command
        manager.createNewSession(LocalTerminalDirectRunner.createTerminalRunner(host.project), state)
        val tw = manager.toolWindow ?: ToolWindowManager.getInstance(host.project).getToolWindow("Terminal") ?: return
        watch(tw)
        tw.contentManager.contents.lastOrNull { it.displayName == name }?.let { contents[id] = it }
        tw.activate(null)
    }

    // A tab the user closes is a terminal that ended for the extension.
    private fun watch(tw: ToolWindow) {
        if (watching === tw) return
        watching = tw
        tw.contentManager.addContentManagerListener(object : ContentManagerListener {
            override fun contentRemoved(event: ContentManagerEvent) {
                val id = contents.entries.firstOrNull { it.value === event.content }?.key ?: return
                contents.remove(id)
                host.notify("terminal.closed", jsonOf("id" to id))
            }
        })
    }

    fun show(id: String?) {
        val c = contents[id ?: return] ?: return
        val tw = watching ?: return
        tw.contentManager.setSelectedContent(c)
        tw.activate(null)
    }

    fun sendText(id: String?, text: String) {
        val c = contents[id ?: return] ?: return
        val widget = TerminalToolWindowManager.getWidgetByContent(c) ?: return
        runCatching { widget.ttyConnector?.write(text) }
    }

    fun close(id: String?) {
        val c = contents.remove(id ?: return) ?: return
        watching?.contentManager?.removeContent(c, true)
    }
}
