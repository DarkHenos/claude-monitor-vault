package com.alexossart.claudemonitorvault

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.intellij.CommonBundle
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.BrowserUtil
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.JBPopupListener
import com.intellij.openapi.ui.popup.LightweightWindowEvent
import com.intellij.openapi.ui.popup.ListPopupStepEx
import com.intellij.openapi.ui.popup.ListSeparator
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.WindowManager
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.CheckBoxList
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.StatusText
import java.awt.Dimension
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import javax.swing.JComponent
import javax.swing.event.DocumentEvent
import javax.swing.text.JTextComponent

// What the extension asks the IDE to show. Each VS Code call (host/vscode-shim.js
// names them) is drawn with the IDE's own components: modal messages are
// Messages dialogs, toasts are notifications, the quick pick is a list popup,
// the input box a small dialog whose validation still runs in the extension.
class HostUi(private val host: NodeHost) {
    private val project get() = host.project
    private val terminals = Terminals(host)
    private val progress = ConcurrentHashMap<String, CountDownLatch>()
    private var statusMessage: String = ""

    private fun edt(modality: ModalityState = ModalityState.any(), action: () -> Unit) {
        ApplicationManager.getApplication().invokeLater({ if (!project.isDisposed) action() }, modality)
    }

    // ------------------------------------------------------------ dispatch

    // Display updates run even while a modal dialog is open: a panel that froze
    // behind a confirmation would look broken.
    fun onNotification(method: String, p: JsonObject) = edt {
        val w = host.webviews
        when (method) {
            "webview.setHtml" -> w.onSetHtml(p)
            "webview.post" -> w.onPost(p)
            "view.update" -> w.onViewUpdate(p)
            "view.focus" -> w.onViewFocus()
            "panel.create" -> w.onPanelCreate(p)
            "panel.update" -> w.onPanelUpdate(p)
            "panel.reveal" -> w.onPanelReveal(p)
            "panel.dispose" -> w.onPanelDispose(p)
            "statusBar.update" -> host.status.update(p)
            "statusBar.dispose" -> host.status.remove(p)
            "statusBar.message" -> setStatusMessage(p.str("text") ?: "", p.long("timeout"))
            "terminal.create" -> terminals.create(p)
            "terminal.show" -> terminals.show(p.str("id"))
            "terminal.sendText" -> terminals.sendText(p.str("id"), p.str("text") ?: "")
            "terminal.dispose" -> terminals.close(p.str("id"))
            "editor.openText" -> openText(p)
            "editor.openFile" -> openFile(p.str("path"))
            "editor.diff" -> diff(p)
            "settings.open" -> Ide.openSettings(project)
            "progress.start" -> startProgress(p.str("id") ?: "", p.str("title") ?: "")
            "progress.end" -> progress.remove(p.str("id") ?: "")?.countDown()
            else -> Plugin.LOG.debug("unhandled notification $method")
        }
    }

    // Questions wait for any dialog already open to close, one at a time, as
    // they do in VS Code.
    fun onRequest(method: String, p: JsonObject): CompletableFuture<JsonElement> {
        val f = CompletableFuture<JsonElement>()
        val run: () -> JsonElement? = when (method) {
            "window.showMessage" -> { -> showMessage(p, f); null }
            "window.showQuickPick" -> { -> showQuickPick(p, f); null }
            "window.showInputBox" -> { -> showInputBox(p) }
            "window.showOpenDialog" -> { -> showOpenDialog(p) }
            "window.showSaveDialog" -> { -> showSaveDialog(p) }
            "env.clipboard.write" -> { ->
                CopyPasteManager.getInstance().setContents(StringSelection(p.str("text") ?: ""))
                JsonNull.INSTANCE
            }
            "env.clipboard.read" -> { ->
                val s = runCatching { CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor) }.getOrNull()
                if (s == null) JsonNull.INSTANCE else JsonPrimitive(s)
            }
            "env.openExternal" -> { -> BrowserUtil.browse(p.str("url") ?: ""); JsonPrimitive(true) }
            else -> { f.completeExceptionally(UnsupportedOperationException("unknown method $method")); return f }
        }
        edt(ModalityState.NON_MODAL) {
            try {
                val r = run()
                if (r != null) f.complete(r)
            } catch (e: Throwable) {
                f.completeExceptionally(e)
            }
        }
        return f
    }

    fun notifyError(text: String) = edt {
        Notifications.Bus.notify(Notification(Plugin.NOTIFICATIONS, Plugin.NOTIFICATIONS, html(text), NotificationType.ERROR), project)
    }

    private fun html(text: String) = StringUtil.escapeXmlEntities(text).replace("\n", "<br>")

    // ------------------------------------------------------------ messages

    private fun showMessage(p: JsonObject, f: CompletableFuture<JsonElement>) {
        val items = p.arr("items").map { it.asString }
        val message = p.str("message") ?: ""
        val detail = p.str("detail")
        val severity = p.str("severity")
        if (p.bool("modal")) {
            val buttons = if (items.isEmpty()) listOf(CommonBundle.getOkButtonText())
                else items + CommonBundle.getCancelButtonText()
            val icon = when (severity) {
                "error" -> Messages.getErrorIcon()
                "warning" -> Messages.getWarningIcon()
                else -> Messages.getInformationIcon()
            }
            val text = if (detail.isNullOrBlank()) message else message + "\n\n" + detail
            val i = Messages.showDialog(project, text, Plugin.NOTIFICATIONS, buttons.toTypedArray(), 0, icon)
            f.complete(if (i in items.indices) JsonPrimitive(i) else JsonNull.INSTANCE)
            return
        }
        val type = when (severity) {
            "error" -> NotificationType.ERROR
            "warning" -> NotificationType.WARNING
            else -> NotificationType.INFORMATION
        }
        val body = html(message) + if (detail.isNullOrBlank()) "" else "<br>" + html(detail)
        val n = Notification(Plugin.NOTIFICATIONS, Plugin.NOTIFICATIONS, body, type)
        // A toast with buttons waits for its answer; dismissed or expired, it
        // answers undefined, as VS Code does when a toast is closed.
        items.forEachIndexed { i, label ->
            n.addAction(NotificationAction.createSimpleExpiring(label) { f.complete(JsonPrimitive(i)) })
        }
        n.whenExpired { f.complete(JsonNull.INSTANCE) }
        Notifications.Bus.notify(n, project)
        if (items.isEmpty()) f.complete(JsonNull.INSTANCE)
    }

    private fun setStatusMessage(text: String, timeout: Long) {
        statusMessage = text
        val bar = WindowManager.getInstance().getStatusBar(project) ?: return
        bar.info = text
        if (timeout > 0 && text.isNotEmpty()) {
            com.intellij.util.Alarm(com.intellij.util.Alarm.ThreadToUse.SWING_THREAD, host).addRequest({
                if (statusMessage == text) { statusMessage = ""; bar.info = "" }
            }, timeout.toInt())
        }
    }

    // ---------------------------------------------------------- quick pick

    private class PickItem(val index: Int, val label: String, val description: String, val detail: String)

    private fun showQuickPick(p: JsonObject, f: CompletableFuture<JsonElement>) {
        val raw = p.arr("items").map { it.asJsonObject }
        val title = listOfNotNull(p.str("title"), p.str("placeHolder")?.takeIf { p.str("title") == null })
            .firstOrNull() ?: Plugin.NOTIFICATIONS
        if (p.bool("canPickMany")) {
            f.complete(pickMany(raw, title, p.str("placeHolder")))
            return
        }
        val items = ArrayList<PickItem>()
        val separators = HashMap<Int, String>()
        var pendingSeparator: String? = null
        raw.forEachIndexed { i, o ->
            if (o.bool("separator")) { pendingSeparator = o.str("label") ?: ""; return@forEachIndexed }
            val item = PickItem(i, o.str("label") ?: "", o.str("description") ?: "", o.str("detail") ?: "")
            pendingSeparator?.let { separators[items.size] = it }
            pendingSeparator = null
            items.add(item)
        }
        if (items.isEmpty()) { f.complete(JsonNull.INSTANCE); return }
        val step = object : BaseListPopupStep<PickItem>(title, items), ListPopupStepEx<PickItem> {
            override fun getTextFor(value: PickItem) =
                if (value.detail.isNotBlank()) value.label + "  ·  " + value.detail else value.label
            override fun getValueFor(t: PickItem): String? = t.description.ifBlank { null }
            override fun getTooltipTextFor(value: PickItem): String? = value.detail.ifBlank { null }
            override fun setEmptyText(emptyText: StatusText) {}
            override fun getSeparatorAbove(value: PickItem): ListSeparator? =
                separators[items.indexOf(value)]?.let { ListSeparator(it) }
            override fun isSpeedSearchEnabled() = true
            override fun onChosen(selectedValue: PickItem, finalChoice: Boolean): PopupStep<*>? {
                f.complete(JsonPrimitive(selectedValue.index))
                return PopupStep.FINAL_CHOICE
            }
        }
        val popup = JBPopupFactory.getInstance().createListPopup(step)
        p.str("placeHolder")?.takeIf { p.str("title") != null }?.let { popup.setAdText(it, javax.swing.SwingConstants.LEFT) }
        popup.addListener(object : JBPopupListener {
            override fun onClosed(event: LightweightWindowEvent) {
                if (!event.isOk) f.complete(JsonNull.INSTANCE)
            }
        })
        popup.showCenteredInCurrentWindow(project)
    }

    private fun pickMany(raw: List<JsonObject>, title: String, hint: String?): JsonElement {
        val list = CheckBoxList<Int>()
        raw.forEachIndexed { i, o ->
            if (o.bool("separator")) return@forEachIndexed
            val label = o.str("label") ?: ""
            val desc = o.str("description")?.takeIf { it.isNotBlank() }
            list.addItem(i, if (desc != null) "$label  ·  $desc" else label, o.bool("picked"))
        }
        val dialog = object : DialogWrapper(project, true) {
            init {
                this.title = title
                init()
            }
            override fun createCenterPanel(): JComponent {
                val scroll = JBScrollPane(list)
                scroll.preferredSize = Dimension(JBUI.scale(460), JBUI.scale(320))
                val b = FormBuilder.createFormBuilder()
                if (!hint.isNullOrBlank() && hint != title) b.addComponent(JBLabel(hint))
                return b.addComponentFillVertically(scroll, JBUI.scale(4)).panel
            }
        }
        if (!dialog.showAndGet()) return JsonNull.INSTANCE
        val out = JsonArray()
        raw.indices.filter { !raw[it].bool("separator") && list.isItemSelected(it) }.forEach { out.add(it) }
        return out
    }

    // ----------------------------------------------------------- input box

    private fun showInputBox(p: JsonObject): JsonElement {
        val dialog = InputDialog(p)
        return if (dialog.showAndGet()) JsonPrimitive(dialog.value) else JsonNull.INSTANCE
    }

    private inner class InputDialog(private val p: JsonObject) : DialogWrapper(project, true) {
        private val password = p.bool("password")
        private val input: JTextComponent = if (password) JBPasswordField() else JBTextField()
        private var error: String? = p.str("error")
        private var errorFor: String? = p.str("value")
        private var asked = 0L

        val value: String get() = if (password) String((input as JBPasswordField).password) else input.text

        init {
            title = p.str("title") ?: Plugin.NOTIFICATIONS
            input.text = p.str("value") ?: ""
            val ph = p.str("placeHolder")
            if (ph != null) {
                if (input is JBTextField) input.emptyText.text = ph
                if (input is JBPasswordField) input.emptyText.text = ph
            }
            // validateInput lives in the extension: every change is sent there,
            // and the answer is shown under the input. Only the latest answer
            // counts, and only for the text it was computed for.
            if (p.bool("validate")) {
                input.document.addDocumentListener(object : DocumentAdapter() {
                    override fun textChanged(e: DocumentEvent) { ask() }
                })
            }
            init()
            if (error != null || p.bool("validate")) initValidation()
            if (p.bool("validate") && error == null) ask()
        }

        private fun ask() {
            val text = value
            val n = ++asked
            host.request("input.validate", jsonOf("token" to p.str("token"), "value" to text)).thenAccept { r ->
                ApplicationManager.getApplication().invokeLater({
                    if (n != asked) return@invokeLater
                    error = if (r == null || r.isJsonNull) null else r.asString
                    errorFor = text
                }, ModalityState.any())
            }
        }

        override fun doValidate(): ValidationInfo? {
            val e = error ?: return null
            return if (errorFor == value) ValidationInfo(e, input) else null
        }

        override fun createCenterPanel(): JComponent {
            input.preferredSize = Dimension(JBUI.scale(420), input.preferredSize.height)
            val b = FormBuilder.createFormBuilder()
            p.str("prompt")?.let { b.addComponent(JBLabel("<html>" + html(it) + "</html>")) }
            return b.addComponent(input).panel
        }

        override fun getPreferredFocusedComponent(): JComponent = input
    }

    // ------------------------------------------------------- file dialogs

    private fun extensions(p: JsonObject): List<String> =
        p.obj("filters")?.entrySet()?.flatMap { (_, v) -> if (v.isJsonArray) v.asJsonArray.map { it.asString } else emptyList() }
            ?: emptyList()

    private fun showOpenDialog(p: JsonObject): JsonElement {
        val exts = extensions(p).map { it.lowercase() }
        val descriptor = FileChooserDescriptor(p.bool("canSelectFiles"), p.bool("canSelectFolders"),
            false, false, false, p.bool("canSelectMany"))
        p.str("title")?.let { descriptor.title = it }
        if (exts.isNotEmpty()) descriptor.withFileFilter { it.isDirectory || exts.contains(it.extension?.lowercase()) }
        val start = p.str("defaultPath")?.let { LocalFileSystem.getInstance().findFileByPath(it) }
        val files = FileChooser.chooseFiles(descriptor, project, start)
        if (files.isEmpty()) return JsonNull.INSTANCE
        val out = JsonArray()
        files.forEach { out.add(File(it.path).path) }
        return out
    }

    private fun showSaveDialog(p: JsonObject): JsonElement {
        val exts = extensions(p)
        val descriptor = FileSaverDescriptor(p.str("title") ?: Plugin.NOTIFICATIONS, "", *exts.toTypedArray())
        val default = p.str("defaultPath")?.let { File(it) }
        val dir = default?.parentFile?.let { LocalFileSystem.getInstance().findFileByIoFile(it) }
        val wrapper = FileChooserFactory.getInstance().createSaveFileDialog(descriptor, project)
            .save(dir, default?.name) ?: return JsonNull.INSTANCE
        return JsonPrimitive(wrapper.file.path)
    }

    // ------------------------------------------------------------ editors

    private fun openText(p: JsonObject) {
        val lang = p.str("language") ?: "plaintext"
        val type = when (lang) {
            "markdown" -> FileTypeManager.getInstance().getFileTypeByExtension("md")
            "json" -> FileTypeManager.getInstance().getFileTypeByExtension("json")
            else -> PlainTextFileType.INSTANCE
        }
        val name = (p.str("title") ?: "Claude Monitor").replace(Regex("[\\\\/:*?\"<>|]"), " ").trim()
        val file = LightVirtualFile(name + "." + type.defaultExtension.ifBlank { "txt" }, type, p.str("content") ?: "")
        FileEditorManager.getInstance(project).openFile(file, true)
    }

    private fun openFile(path: String?) {
        if (path.isNullOrBlank()) return
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(path.replace('\\', '/')) ?: return
        FileEditorManager.getInstance(project).openFile(vf, true)
    }

    private fun diff(p: JsonObject) {
        val f = DiffContentFactory.getInstance()
        val request = SimpleDiffRequest(p.str("title") ?: "", f.create(project, p.str("left") ?: ""),
            f.create(project, p.str("right") ?: ""), p.str("leftTitle"), p.str("rightTitle"))
        DiffManager.getInstance().showDiff(project, request)
    }

    // ------------------------------------------------------------ progress

    private fun startProgress(id: String, title: String) {
        val latch = CountDownLatch(1)
        progress[id] = latch
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title.ifBlank { Plugin.NOTIFICATIONS }, false) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                latch.await()
            }
        })
    }

    fun dispose() {
        for (l in progress.values) l.countDown()
        progress.clear()
    }
}
