package com.alexossart.claudemonitorvault

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.DynamicBundle
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import java.nio.file.Files
import java.nio.file.Path
import java.util.Locale

// Everything the plugin knows about the extension it runs comes from the
// extension's own files, shipped in <plugin>/node. Nothing here repeats them.
internal object Plugin {
    const val ID = "alexossart.claude-monitor-vault"
    const val NOTIFICATIONS = "Claude Monitor & Vault"
    const val TOOL_WINDOW = "Claude Monitor"
    const val VIEW_ID = "claudeMonitorVault.panel"

    val LOG: Logger = Logger.getInstance("#claude-monitor-vault")
    val gson: Gson = GsonBuilder().disableHtmlEscaping().create()

    val pluginDir: Path
        get() = PluginManagerCore.getPlugin(PluginId.getId(ID))?.pluginPath
            ?: error("plugin $ID is not loaded")

    val nodeDir: Path get() = pluginDir.resolve("node")

    // One folder per IDE installation, beside the IDE's own options: settings,
    // globalState and the extension's global storage. Several projects share it.
    val storageDir: Path get() = Path.of(PathManager.getConfigPath(), "claude-monitor-vault")

    val settingsFile: Path get() = storageDir.resolve("settings.json")

    val appName: String get() = ApplicationInfo.getInstance().fullApplicationName

    // The extension translates itself into en, fr, es, de and pt. The IDE's
    // language when it runs with a language pack, otherwise the system's, which
    // is what VS Code does too when no display language was chosen.
    val language: String
        get() {
            val ide = runCatching { DynamicBundle.getLocale() }.getOrNull()
            val loc = if (ide != null && ide.language != Locale.ENGLISH.language) ide else Locale.getDefault()
            return loc.toLanguageTag().lowercase()
        }

    val manifest: JsonObject by lazy { readJson(nodeDir.resolve("package.json")) }

    // %key% strings of package.json, resolved like VS Code does.
    private val nls: JsonObject by lazy {
        val base = readJson(nodeDir.resolve("package.nls.json"))
        val lang = language.substringBefore('-')
        val local = nodeDir.resolve("package.nls.$lang.json")
        if (lang != "en" && Files.exists(local)) {
            for ((k, v) in readJson(local).entrySet()) base.add(k, v)
        }
        base
    }

    fun nls(value: String?): String {
        if (value == null) return ""
        val m = Regex("^%(.+)%$").find(value) ?: return value
        return nls.get(m.groupValues[1])?.asString ?: value
    }

    fun readJson(p: Path): JsonObject = runCatching {
        JsonParser.parseString(Files.readString(p)).asJsonObject
    }.getOrElse { JsonObject() }
}

internal fun JsonObject.str(key: String): String? =
    get(key)?.takeIf { !it.isJsonNull }?.let { if (it.isJsonPrimitive) it.asString else it.toString() }

internal fun JsonObject.bool(key: String): Boolean =
    get(key)?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false

internal fun JsonObject.long(key: String): Long =
    get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asLong ?: 0L

internal fun JsonObject.obj(key: String): JsonObject? =
    get(key)?.takeIf { it.isJsonObject }?.asJsonObject

internal fun JsonObject.arr(key: String): JsonArray =
    get(key)?.takeIf { it.isJsonArray }?.asJsonArray ?: JsonArray()

internal fun jsonOf(vararg pairs: Pair<String, Any?>): JsonObject {
    val o = JsonObject()
    for ((k, v) in pairs) o.add(k, toJson(v))
    return o
}

internal fun toJson(v: Any?): JsonElement = when (v) {
    null -> JsonNull.INSTANCE
    is JsonElement -> v
    else -> Plugin.gson.toJsonTree(v)
}
