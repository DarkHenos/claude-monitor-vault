package com.alexossart.claudemonitorvault

import com.intellij.ide.impl.isTrusted
import com.intellij.ide.ui.LafManager
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileDocumentManagerListener
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.WindowManager
import org.jetbrains.plugins.terminal.TerminalProjectOptionsProvider
import java.awt.Window
import java.awt.event.WindowAdapter
import java.awt.event.WindowEvent
import javax.swing.SwingUtilities

internal object Ide {
    fun shellPath(project: Project): String? =
        runCatching { TerminalProjectOptionsProvider.getInstance(project).shellPath }.getOrNull()

    fun isTrusted(project: Project): Boolean = runCatching { project.isTrusted() }.getOrDefault(true)

    fun isFocused(project: Project): Boolean = WindowManager.getInstance().getFrame(project)?.isActive ?: false

    fun openSettings(project: Project) {
        ShowSettingsUtil.getInstance().showSettingsDialog(project, SettingsConfigurable::class.java)
    }

    fun updateToolWindowTitle(project: Project, description: String?) {
        val tw = ToolWindowManager.getInstance(project).getToolWindow(Plugin.TOOL_WINDOW) ?: return
        tw.contentManager.getContent(0)?.displayName = description ?: ""
    }

    // VS Code's window.state.focused: only the focused window calls the usage
    // API, the others follow the shared cache. A dialog of this same window
    // still counts as this window.
    fun watchFocus(project: Project) {
        val frame = WindowManager.getInstance().getFrame(project) ?: return
        frame.addWindowListener(object : WindowAdapter() {
            override fun windowActivated(e: WindowEvent) = send(true)
            override fun windowDeactivated(e: WindowEvent) {
                val other: Window? = e.oppositeWindow
                send(other != null && SwingUtilities.isDescendingFrom(other, frame) || other?.owner === frame)
            }
            private fun send(focused: Boolean) {
                if (!project.isDisposed) NodeHost.get(project).notify("window.state", jsonOf("focused" to focused))
            }
        })
    }
}

class Startup : ProjectActivity {
    override suspend fun execute(project: Project) {
        Commands.register()
        ApplicationManager.getApplication().invokeLater({
            if (project.isDisposed) return@invokeLater
            Ide.watchFocus(project)
            NodeHost.get(project).start()
        }, ModalityState.NON_MODAL)
    }
}

// The commit guard warns when a saved file holds one of the vault's values in
// clear. The text goes to the host of the project the file belongs to, which
// compares it with the vault and keeps nothing.
class SaveListener : FileDocumentManagerListener {
    override fun beforeDocumentSaving(document: Document) {
        if (document.textLength > 2_000_000) return
        val file = FileDocumentManager.getInstance().getFile(document) ?: return
        if (!file.isInLocalFileSystem) return
        val projects = ProjectManager.getInstance().openProjects.filter { !it.isDisposed }
        val owner = projects.firstOrNull { p ->
            runCatching { ProjectFileIndex.getInstance(p).isInContent(file) }.getOrDefault(false)
        } ?: return
        val host = NodeHost.get(owner)
        if (!host.isRunning) return
        host.notify("document.saved", jsonOf("path" to java.io.File(file.path).path, "text" to document.text))
    }
}

class ThemeListener : LafManagerListener {
    override fun lookAndFeelChanged(source: LafManager) {
        for (p in ProjectManager.getInstance().openProjects) {
            if (!p.isDisposed) NodeHost.get(p).webviews.themeChanged()
        }
    }
}
