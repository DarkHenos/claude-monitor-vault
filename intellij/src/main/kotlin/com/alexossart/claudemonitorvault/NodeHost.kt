package com.alexossart.claudemonitorvault

import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.EnvironmentUtil
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

// One Node process per open project, like VS Code runs one extension host per
// window. It runs host/main.js, which loads the extension unchanged; this class
// is the IDE end of the JSON-RPC line protocol described in host/rpc.js.
//
// Values typed into a masked input box cross this pipe. Message bodies are
// never logged here; only the extension's own stderr reaches the IDE log.
@Service(Service.Level.PROJECT)
class NodeHost(val project: Project) : Disposable {

    companion object {
        fun get(project: Project): NodeHost = project.service()
        const val NODE_PATH_KEY = "claudeMonitorVault.nodePath"
    }

    private val lock = Any()
    private var process: Process? = null
    private var writer: BufferedWriter? = null
    private val pending = ConcurrentHashMap<Long, CompletableFuture<JsonElement>>()
    private val nextId = AtomicLong(1)
    @Volatile private var ready = CompletableFuture<JsonObject>()
    @Volatile private var disposed = false
    @Volatile private var stopping = false

    val ui = HostUi(this)
    val webviews = Webviews(this)
    val status = StatusModel()

    val isRunning: Boolean get() = process?.isAlive == true

    fun start() {
        synchronized(lock) {
            if (disposed || process?.isAlive == true) return
            val node = NodeLocator.find()
            if (node == null) {
                notifyMissingNode()
                return
            }
            val main = Plugin.nodeDir.resolve("host").resolve("main.js").toString()
            val pb = ProcessBuilder(node, main).directory(Plugin.nodeDir.toFile())
            // On macOS an IDE started from the Dock has a bare PATH; the login
            // shell's environment is what finds claude, codex and git.
            pb.environment().putAll(EnvironmentUtil.getEnvironmentMap())
            val p = try { pb.start() } catch (e: Exception) {
                Plugin.LOG.warn("cannot start node", e)
                notifyMissingNode()
                return
            }
            process = p
            stopping = false
            ready = CompletableFuture()
            writer = BufferedWriter(OutputStreamWriter(p.outputStream, StandardCharsets.UTF_8))
            val reader = Thread({ readLoop(p) }, "Claude Monitor host reader")
            reader.isDaemon = true
            reader.start()
            val err = Thread({
                BufferedReader(InputStreamReader(p.errorStream, StandardCharsets.UTF_8)).useLines { lines ->
                    lines.forEach { Plugin.LOG.info("[node] $it") }
                }
            }, "Claude Monitor host log")
            err.isDaemon = true
            err.start()
        }
        val params = jsonOf(
            "storagePath" to Plugin.storageDir.toString(),
            "workspaceFolders" to listOfNotNull(project.basePath?.let { File(it).path }),
            "language" to Plugin.language,
            "shell" to Ide.shellPath(project),
            "trusted" to Ide.isTrusted(project),
            "focused" to Ide.isFocused(project),
            "appName" to Plugin.appName
        )
        request("initialize", params).whenComplete { result, error ->
            if (error != null) {
                Plugin.LOG.warn("extension activation failed", error)
                ui.notifyError("Claude Monitor & Vault: " + (error.cause?.message ?: error.message))
                ready.completeExceptionally(error)
            } else {
                ready.complete(result as? JsonObject ?: JsonObject())
                ApplicationManager.getApplication().invokeLater({ webviews.hostReady() }, ModalityState.any())
            }
        }
    }

    /** Runs once the extension is active, at once if it already is. */
    fun whenReady(action: () -> Unit) {
        ready.thenRun { ApplicationManager.getApplication().invokeLater({ if (!project.isDisposed) action() }, ModalityState.any()) }
    }

    fun executeCommand(command: String, vararg args: Any?) {
        if (!isRunning) start()
        whenReady {
            request("command.execute", jsonOf("command" to command, "args" to args.toList()))
                .whenComplete { _, error ->
                    if (error != null) ui.notifyError(error.cause?.message ?: error.message ?: "error")
                }
        }
    }

    fun request(method: String, params: Any? = null): CompletableFuture<JsonElement> {
        val id = nextId.getAndIncrement()
        val f = CompletableFuture<JsonElement>()
        pending[id] = f
        if (!send(jsonOf("id" to id, "method" to method, "params" to params))) {
            pending.remove(id)
            f.completeExceptionally(IllegalStateException("the extension host is not running"))
        }
        return f
    }

    fun notify(method: String, params: Any? = null) {
        send(jsonOf("method" to method, "params" to params))
    }

    private fun send(msg: JsonObject): Boolean {
        val w = writer ?: return false
        return try {
            synchronized(w) {
                w.write(Plugin.gson.toJson(msg))
                w.write("\n")
                w.flush()
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun respond(id: JsonElement, result: JsonElement?, error: Throwable?) {
        val msg = JsonObject()
        msg.add("id", id)
        if (error != null) msg.add("error", jsonOf("message" to (error.message ?: error.toString())))
        else msg.add("result", result ?: JsonNull.INSTANCE)
        send(msg)
    }

    private fun readLoop(p: Process) {
        try {
            BufferedReader(InputStreamReader(p.inputStream, StandardCharsets.UTF_8)).useLines { lines ->
                lines.forEach { line -> if (line.isNotBlank()) handleLine(line) }
            }
        } catch (e: Exception) {
            if (!stopping) Plugin.LOG.warn("host connection lost", e)
        }
        onExit(p)
    }

    private fun handleLine(line: String) {
        val msg = try { JsonParser.parseString(line).asJsonObject } catch (e: Exception) {
            Plugin.LOG.warn("unreadable message from the extension host")
            return
        }
        val method = msg.str("method")
        val params = msg.get("params")?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
        if (method == null) {
            val id = msg.long("id")
            val f = pending.remove(id) ?: return
            val err = msg.obj("error")
            if (err != null) f.completeExceptionally(RuntimeException(err.str("message") ?: "error"))
            else f.complete(msg.get("result") ?: JsonNull.INSTANCE)
            return
        }
        val id = msg.get("id")
        if (id == null || id.isJsonNull) {
            ui.onNotification(method, params)
            return
        }
        ui.onRequest(method, params).whenComplete { result, error -> respond(id, result, error) }
    }

    private fun onExit(p: Process) {
        synchronized(lock) {
            if (process !== p) return
            process = null
            writer = null
        }
        for (f in pending.values) f.completeExceptionally(IllegalStateException("the extension host stopped"))
        pending.clear()
        if (!ready.isDone) ready.completeExceptionally(IllegalStateException("the extension host stopped"))
        ApplicationManager.getApplication().invokeLater({
            if (project.isDisposed) return@invokeLater
            ui.dispose()
            status.clear()
            webviews.hostStopped()
            if (!stopping && !disposed) notifyStopped(p)
        }, ModalityState.any())
    }

    private fun notifyStopped(p: Process) {
        val code = runCatching { p.exitValue() }.getOrDefault(-1)
        val n = Notification(Plugin.NOTIFICATIONS, Plugin.NOTIFICATIONS, Texts.t("stopped", code), NotificationType.WARNING)
        n.addAction(NotificationAction.createSimpleExpiring(Texts.t("restart")) { start() })
        Notifications.Bus.notify(n, project)
    }

    private fun notifyMissingNode() {
        val n = Notification(Plugin.NOTIFICATIONS, Plugin.NOTIFICATIONS,
            Texts.t("nodeMissing", Plugin.NOTIFICATIONS), NotificationType.ERROR)
        n.addAction(NotificationAction.createSimpleExpiring(Texts.t("openSettings")) { Ide.openSettings(project) })
        Notifications.Bus.notify(n, project)
    }

    fun restart() {
        stop()
        start()
    }

    /** Clean shutdown, as VS Code does when a window closes: the vault drops its session keys. */
    internal fun stop() {
        val p = synchronized(lock) { process } ?: return
        stopping = true
        try { request("shutdown").get(1500, TimeUnit.MILLISECONDS) } catch (e: Exception) { /* forced below */ }
        try { p.outputStream.close() } catch (e: Exception) { /* already closed */ }
        if (!p.waitFor(1000, TimeUnit.MILLISECONDS)) p.destroyForcibly()
        onExit(p)
    }

    override fun dispose() {
        stop()
        disposed = true
    }
}

internal object NodeLocator {
    fun find(): String? {
        val configured = PropertiesComponent.getInstance().getValue(NodeHost.NODE_PATH_KEY)
        if (!configured.isNullOrBlank() && File(configured).isFile) return configured
        val exe = if (SystemInfo.isWindows) "node.exe" else "node"
        val path = EnvironmentUtil.getValue("PATH") ?: System.getenv("PATH") ?: ""
        for (dir in path.split(File.pathSeparatorChar)) {
            val d = dir.trim().trim('"')
            if (d.isEmpty()) continue
            val f = File(d, exe)
            if (f.isFile) return f.path
        }
        val home = System.getProperty("user.home")
        val candidates = mutableListOf<File>()
        if (SystemInfo.isWindows) {
            System.getenv("ProgramFiles")?.let { candidates += File(it, "nodejs\\node.exe") }
            candidates += File("C:\\nvm4w\\nodejs\\node.exe")
            System.getenv("NVM_SYMLINK")?.let { candidates += File(it, "node.exe") }
            System.getenv("LOCALAPPDATA")?.let { candidates += File(it, "Volta\\bin\\node.exe") }
        } else {
            candidates += File("/opt/homebrew/bin/node")
            candidates += File("/usr/local/bin/node")
            candidates += File("/usr/bin/node")
            candidates += File(home, ".volta/bin/node")
            File(home, ".nvm/versions/node").listFiles()?.sortedByDescending { it.name }?.forEach {
                candidates += File(it, "bin/node")
            }
        }
        return candidates.firstOrNull { it.isFile }?.path
    }
}
