package com.alexossart.claudemonitorvault

import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.TitledSeparator
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import javax.swing.JComponent
import javax.swing.JSpinner
import javax.swing.SpinnerNumberModel

// Settings, Tools, Claude Monitor & Vault: the extension's settings, built from
// the configuration schema of package.json the way VS Code builds its own
// settings page. Values go to the same settings.json the extension reads; the
// extension watches that file, so Apply takes effect at once.
class SettingsConfigurable : Configurable {
    private class Field(val key: String, val component: JComponent, val read: () -> JsonElement?, val write: (JsonElement?) -> Unit)

    private val fields = ArrayList<Field>()
    private var nodePath: TextFieldWithBrowseButton? = null

    override fun getDisplayName() = Plugin.NOTIFICATIONS

    override fun createComponent(): JComponent {
        fields.clear()
        val props = Plugin.manifest.obj("contributes")?.obj("configuration")?.obj("properties") ?: JsonObject()
        val b = FormBuilder.createFormBuilder()
        b.addComponent(JBLabel(Texts.t("beta")).apply { foreground = UIUtil.getContextHelpForeground() })

        val node = TextFieldWithBrowseButton()
        node.addActionListener {
            val start = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(node.text.trim())
            com.intellij.openapi.fileChooser.FileChooser.chooseFile(
                FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor(), null, start
            )?.let { node.text = java.io.File(it.path).path }
        }
        (node.textField as? JBTextField)?.emptyText?.text = Texts.t("nodePathHint")
        nodePath = node
        b.addLabeledComponent(Texts.t("nodePath"), node)

        var section = ""
        for ((key, v) in props.entrySet()) {
            val schema = v.asJsonObject
            if (schema.has("deprecationMessage")) continue
            val prefix = key.substringBefore('.')
            if (prefix != section) {
                section = prefix
                val title = when (prefix) {
                    "claudeLimits" -> Plugin.nls("%cat.limits%")
                    "agentBridge" -> Plugin.nls("%cat.monitor%")
                    else -> prefix
                }
                b.addComponent(TitledSeparator(title), JBUI.scale(12))
            }
            val description = Plugin.nls(schema.str("description") ?: schema.str("markdownDescription") ?: key)
            val field = fieldFor(key, schema, description) ?: continue
            fields.add(field)
            if (field.component is JBCheckBox) b.addComponent(field.component)
            else b.addLabeledComponent("<html>" + com.intellij.openapi.util.text.StringUtil.escapeXmlEntities(description) +
                "</html>", field.component, true)
        }
        return JBUI.Panels.simplePanel().addToTop(b.panel)
    }

    private fun fieldFor(key: String, schema: JsonObject, description: String): Field? {
        val default = schema.get("default")
        return when (schema.str("type")) {
            "boolean" -> {
                val c = JBCheckBox(description)
                Field(key, c, { JsonPrimitive(c.isSelected) }, { c.isSelected = (it ?: default)?.asBoolean ?: false })
            }
            "number", "integer" -> {
                val min = schema.get("minimum")?.asDouble ?: 0.0
                val model = SpinnerNumberModel(default?.asDouble ?: min, min, schema.get("maximum")?.asDouble ?: 1_000_000.0, 1.0)
                val c = JSpinner(model)
                Field(key, c, { JsonPrimitive((c.value as Number).toInt()) },
                    { c.value = ((it ?: default)?.asDouble ?: min).coerceAtLeast(min) })
            }
            "string" -> {
                val options = schema.arr("enum").map { it.asString }
                if (options.isNotEmpty()) {
                    val labels = schema.arr("enumDescriptions").map { Plugin.nls(it.asString) }
                    val c = ComboBox(options.toTypedArray())
                    c.renderer = com.intellij.ui.SimpleListCellRenderer.create("") { value: String? ->
                        val i = options.indexOf(value)
                        if (i in labels.indices) "$value  ·  ${labels[i]}" else value ?: ""
                    }
                    Field(key, c, { JsonPrimitive(c.selectedItem as String) },
                        { c.selectedItem = (it ?: default)?.asString ?: options.first() })
                } else {
                    val c = JBTextField()
                    Field(key, c, { c.text.takeIf { s -> s.isNotBlank() }?.let { s -> JsonPrimitive(s) } },
                        { c.text = (it ?: default)?.asString ?: "" })
                }
            }
            // Lists such as the status bar colour bands have their own editor
            // in the panel's settings page.
            else -> Field(key, JBLabel(Texts.t("editedInPanel")).apply { foreground = UIUtil.getContextHelpForeground() },
                { null }, {})
        }
    }

    private fun stored(): JsonObject = Plugin.readJson(Plugin.settingsFile)

    // A value equal to its default is not written, as in VS Code's settings.json.
    private fun collected(): JsonObject {
        val props = Plugin.manifest.obj("contributes")?.obj("configuration")?.obj("properties") ?: JsonObject()
        val out = stored().deepCopy()
        for (f in fields) {
            if (f.component is JBLabel) continue
            val v = f.read()
            val default = props.obj(f.key)?.get("default")
            if (v == null || v == default) out.remove(f.key) else out.add(f.key, v)
        }
        return out
    }

    override fun isModified(): Boolean =
        collected() != stored() || (nodePath?.text ?: "") != (PropertiesComponent.getInstance().getValue(NodeHost.NODE_PATH_KEY) ?: "")

    override fun apply() {
        val next = collected()
        if (next != stored()) {
            Files.createDirectories(Plugin.storageDir)
            val tmp = Plugin.settingsFile.resolveSibling("settings.json.ide.tmp")
            Files.writeString(tmp, GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(next))
            Files.move(tmp, Plugin.settingsFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }
        val before = PropertiesComponent.getInstance().getValue(NodeHost.NODE_PATH_KEY) ?: ""
        val now = nodePath?.text?.trim() ?: ""
        if (now != before) {
            PropertiesComponent.getInstance().setValue(NodeHost.NODE_PATH_KEY, now.ifBlank { null })
            for (p in ProjectManager.getInstance().openProjects) if (!p.isDisposed) NodeHost.get(p).restart()
        }
    }

    override fun reset() {
        val s = stored()
        for (f in fields) f.write(s.get(f.key))
        nodePath?.text = PropertiesComponent.getInstance().getValue(NodeHost.NODE_PATH_KEY) ?: ""
    }
}
