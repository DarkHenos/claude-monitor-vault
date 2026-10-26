package com.alexossart.claudemonitorvault

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorLocation
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import java.beans.PropertyChangeListener
import javax.swing.JComponent

// createWebviewPanel opens a page in the editor area in VS Code; here it is an
// editor tab too, backed by an in-memory file that only this provider opens.
class WebviewVirtualFile(val webviewId: String, title: String) :
    LightVirtualFile(title.ifBlank { "Claude Monitor" }, PlainTextFileType.INSTANCE, "") {
    init { isWritable = false }
}

internal object WebviewFiles {
    fun open(project: Project, model: WebviewModel) {
        val fem = FileEditorManager.getInstance(project)
        val file = fem.webviewFile(model.id) ?: WebviewVirtualFile(model.id, model.title)
        fem.openFile(file, true)
    }

    fun retitle(project: Project, model: WebviewModel) {
        // Tab titles follow the file name, fixed when the tab opened. The
        // extension only names a page once, so there is nothing to follow.
    }

    fun close(project: Project, id: String) {
        val fem = FileEditorManager.getInstance(project)
        fem.webviewFile(id)?.let { fem.closeFile(it) }
    }
}

class WebviewEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile) = file is WebviewVirtualFile
    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        WebviewFileEditor(project, file as WebviewVirtualFile)
    override fun getEditorTypeId() = "claude-monitor-vault-webview"
    override fun getPolicy() = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}

class WebviewFileEditor(project: Project, private val file: WebviewVirtualFile) : UserDataHolderBase(), FileEditor {
    private val host = NodeHost.get(project)
    private val model = host.webviews.model(file.webviewId, true)
    private val view = WebviewBrowser(model, this)

    override fun getComponent(): JComponent = view.component
    override fun getPreferredFocusedComponent(): JComponent = view.component
    override fun getName() = model.title
    override fun getFile(): VirtualFile = file
    override fun setState(state: FileEditorState) {}
    override fun isModified() = false
    override fun isValid() = true
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}
    override fun getCurrentLocation(): FileEditorLocation? = null
    override fun dispose() {
        host.webviews.onTabClosed(file.webviewId)
    }
}
