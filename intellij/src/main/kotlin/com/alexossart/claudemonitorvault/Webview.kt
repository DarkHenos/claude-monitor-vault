package com.alexossart.claudemonitorvault

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.JBUI
import javax.swing.JComponent
import javax.swing.SwingConstants

// One page of the extension: the side panel, or a page opened as an editor tab
// (settings, access log, what's new). The model outlives its browser, so html
// and messages that arrive before the tool window or the tab exist are kept.
class WebviewModel(val id: String, private val host: NodeHost, val editorTab: Boolean) {
    var html: String? = null
        private set
    var title: String = ""
    var state: String = "null"
    var browser: WebviewBrowser? = null
        private set
    private val queue = ArrayList<String>()
    private var ready = false

    fun attach(b: WebviewBrowser) {
        browser = b
        ready = false
        html?.let { b.load(it) }
    }

    fun detach(b: WebviewBrowser) {
        if (browser === b) { browser = null; ready = false }
    }

    fun setHtml(value: String) {
        html = value
        ready = false
        browser?.load(value)
    }

    // Like VS Code, messages posted while a page loads are delivered once its
    // scripts are listening, not lost.
    fun post(message: JsonElement) {
        val json = Plugin.gson.toJson(message)
        val b = browser
        if (b != null && ready) b.deliver(json) else queue.add(json)
    }

    fun onPageReady() {
        ready = true
        val b = browser ?: return
        for (m in queue) b.deliver(m)
        queue.clear()
    }

    fun fromPage(message: JsonElement) {
        host.notify("webview.message", jsonOf("id" to id, "message" to message))
    }

    fun reset() {
        html = null
        queue.clear()
        ready = false
        browser?.showStopped()
    }
}

class Webviews(private val host: NodeHost) {
    private val models = HashMap<String, WebviewModel>()
    var viewDescription: String? = null
        private set

    fun model(id: String, editorTab: Boolean = id.startsWith("panel:")): WebviewModel =
        models.getOrPut(id) { WebviewModel(id, host, editorTab) }

    fun find(id: String): WebviewModel? = models[id]

    /** The tool window's browser exists (it attached itself): draw the panel once the extension is ready. */
    fun attachView() {
        if (!host.isRunning) host.start()
        host.whenReady { resolveView() }
    }

    private var resolved = false
    private fun resolveView() {
        if (resolved || model(Plugin.VIEW_ID, false).browser == null) return
        resolved = true
        host.request("view.resolve", jsonOf("id" to Plugin.VIEW_ID)).whenComplete { _, e ->
            if (e != null) { resolved = false; Plugin.LOG.warn("panel could not be drawn", e) }
        }
    }

    fun hostReady() {
        resolveView()
    }

    fun hostStopped() {
        resolved = false
        for (m in models.values.toList()) {
            if (m.editorTab) closeTab(m.id) else m.reset()
        }
        models.keys.retainAll { !it.startsWith("panel:") }
    }

    fun setVisible(id: String, visible: Boolean) {
        host.notify("webview.visible", jsonOf("id" to id, "visible" to visible))
    }

    // ---- notifications from the extension

    fun onSetHtml(p: JsonObject) {
        val id = p.str("id") ?: return
        model(id).setHtml(p.str("html") ?: "")
    }

    fun onPost(p: JsonObject) {
        val id = p.str("id") ?: return
        model(id).post(p.get("message") ?: JsonObject())
    }

    fun onViewUpdate(p: JsonObject) {
        // The panel and its VS Code placeholder both report a description; the
        // last non-empty one is the panel's header text.
        val d = p.str("description")
        if (!d.isNullOrBlank()) viewDescription = d
        Ide.updateToolWindowTitle(host.project, viewDescription)
    }

    fun onViewFocus() {
        ToolWindowManager.getInstance(host.project).getToolWindow(Plugin.TOOL_WINDOW)?.activate(null, true)
    }

    fun onPanelCreate(p: JsonObject) {
        val id = p.str("id") ?: return
        val m = model(id, true)
        m.title = p.str("title") ?: ""
        WebviewFiles.open(host.project, m)
    }

    fun onPanelUpdate(p: JsonObject) {
        val m = find(p.str("id") ?: return) ?: return
        m.title = p.str("title") ?: m.title
        WebviewFiles.retitle(host.project, m)
    }

    fun onPanelReveal(p: JsonObject) {
        val m = find(p.str("id") ?: return) ?: return
        WebviewFiles.open(host.project, m)
    }

    fun onPanelDispose(p: JsonObject) {
        closeTab(p.str("id") ?: return)
    }

    private val closing = HashSet<String>()

    private fun closeTab(id: String) {
        closing.add(id)
        try { WebviewFiles.close(host.project, id) } finally { closing.remove(id) }
        models.remove(id)
    }

    /** The user closed a page's tab. */
    fun onTabClosed(id: String) {
        if (closing.contains(id) || !models.containsKey(id)) return
        models.remove(id)
        host.notify("webview.disposed", jsonOf("id" to id))
    }

    fun themeChanged() {
        for (m in models.values) m.browser?.applyTheme()
    }
}

// The browser itself. It loads the extension's HTML with two additions at the
// top of <head>: the theme variables, and acquireVsCodeApi(), the bridge the
// page's scripts use to talk to the extension. Both carry the page's own CSP
// nonce, so its Content-Security-Policy stays exactly as strict as in VS Code.
class WebviewBrowser(private val model: WebviewModel, parent: Disposable) : Disposable {
    private val browser: JBCefBrowser? = if (JBCefApp.isSupported())
        JBCefBrowser.createBuilder().setEnableOpenDevToolsMenuItem(false).build() else null
    private val query: JBCefJSQuery? = browser?.let { JBCefJSQuery.create(it as JBCefBrowserBase) }
    private val fallback = JBLabel(Texts.t("noJcef"), SwingConstants.CENTER)
    private var mixes: List<Pair<String, String>> = emptyList()

    val component: JComponent get() = browser?.component ?: fallback

    init {
        Disposer.register(parent, this)
        browser?.let { Disposer.register(this, it) }
        query?.let { q ->
            Disposer.register(this, q)
            q.addHandler { request ->
                onPageMessage(request)
                null
            }
        }
        fallback.border = JBUI.Borders.empty(12)
        model.attach(this)
    }

    private fun onPageMessage(request: String) {
        val msg = runCatching { JsonParser.parseString(request).asJsonObject }.getOrNull() ?: return
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater({
            when (msg.str("t")) {
                "ready" -> model.onPageReady()
                "state" -> model.state = msg.get("s")?.let { Plugin.gson.toJson(it) } ?: "null"
                "msg" -> model.fromPage(msg.get("m") ?: JsonObject())
            }
        }, com.intellij.openapi.application.ModalityState.any())
    }

    fun load(html: String) {
        val b = browser ?: return
        b.loadHTML(inject(html))
    }

    fun deliver(json: String) {
        val b = browser ?: return
        b.cefBrowser.executeJavaScript("window.__cmvDeliver && window.__cmvDeliver($json);", b.cefBrowser.url, 0)
    }

    fun applyTheme() {
        val b = browser ?: return
        val vars = Plugin.gson.toJson(Theme.vars(model.editorTab))
        b.cefBrowser.executeJavaScript("window.__cmvTheme && window.__cmvTheme($vars);", b.cefBrowser.url, 0)
    }

    fun showStopped() {
        browser?.loadHTML("<html><body style=\"font-family:sans-serif;opacity:.6;padding:16px\">…</body></html>")
    }

    private val mixRe = Regex("""color-mix\(in srgb,\s*var\((--vscode-[\w-]+)\)\s+([\d.]+)%,\s*transparent\)""")

    // color-mix() arrived in Chromium 111; the IDE's embedded browser can be
    // older. Every "theme colour at N% opacity" the pages use is replaced by a
    // variable the bridge computes, which also follows a theme change.
    private fun inject(html: String): String {
        val found = LinkedHashSet<Pair<String, String>>()
        val body = mixRe.replace(html) { m ->
            val pair = m.groupValues[1] to m.groupValues[2]
            found.add(pair)
            "var(" + mixName(pair) + ")"
        }
        mixes = found.toList()
        val nonce = Regex("""'nonce-([^']+)'""").find(body)?.groupValues?.get(1)
        val n = if (nonce != null) " nonce=\"$nonce\"" else ""
        val q = query
        val post = if (q != null) q.inject("s") else ""
        // Inside a <script> element: the default Gson escapes <, > and &, so no
        // value (the restored state holds key names and notes) can close it.
        val safe = com.google.gson.Gson()
        val vars = safe.toJson(Theme.vars(model.editorTab))
        val mixJson = safe.toJson(mixes.map { listOf(it.first, it.second, mixName(it)) })
        val state = runCatching { safe.toJson(JsonParser.parseString(model.state)) }.getOrDefault("null")
        val head = """
<style$n>
html,body{margin:0;background:var(--cmv-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--cmvscroll);border-radius:5px;border:2px solid transparent;background-clip:content-box}
</style>
<script$n>
(function(){
  var post=function(s){$post};
  var state=$state;
  var mixes=$mixJson;
  function rgba(hex,pct){
    var h=String(hex||'').replace('#','');
    if(h.length===3)h=h.split('').map(function(c){return c+c;}).join('');
    if(h.length<6)return 'transparent';
    var a=h.length>=8?parseInt(h.slice(6,8),16)/255:1;
    return 'rgba('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','+parseInt(h.slice(4,6),16)+','+(a*pct/100).toFixed(3)+')';
  }
  window.__cmvTheme=function(v){
    var s=document.documentElement.style;
    for(var k in v)s.setProperty(k,v[k]);
    for(var i=0;i<mixes.length;i++)s.setProperty(mixes[i][2],rgba(v[mixes[i][0]],parseFloat(mixes[i][1])));
    s.setProperty('--cmvscroll',rgba(v['--vscode-foreground'],22));
  };
  window.__cmvTheme($vars);
  var api={
    postMessage:function(m){post(JSON.stringify({t:'msg',m:m}));},
    getState:function(){return state;},
    setState:function(s){state=s;post(JSON.stringify({t:'state',s:s}));return s;}
  };
  window.acquireVsCodeApi=function(){return api;};
  window.__cmvDeliver=function(m){window.dispatchEvent(new MessageEvent('message',{data:m}));};
  window.addEventListener('load',function(){post(JSON.stringify({t:'ready'}));});
})();
</script>
"""
        val at = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(body)
        return if (at != null) body.substring(0, at.range.last + 1) + head + body.substring(at.range.last + 1)
        else head + body
    }

    private fun mixName(p: Pair<String, String>) = "--cmvmix" + p.first.removePrefix("--") + "-" + p.second.replace('.', '_')

    override fun dispose() {
        model.detach(this)
    }
}

internal fun FileEditorManager.webviewFile(id: String) =
    openFiles.firstOrNull { it is WebviewVirtualFile && it.webviewId == id } as WebviewVirtualFile?
