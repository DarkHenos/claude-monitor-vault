package com.alexossart.claudemonitorvault

// The few sentences the plugin itself says, outside the extension: the
// extension translates everything else with its own l10n bundles. Same five
// languages, same rule: anything unknown falls back to English.
internal object Texts {
    private val en = mapOf(
        "nodeMissing" to "Node.js was not found. Install Node.js 18 or later, or choose its executable in Settings, Tools, {0}.",
        "openSettings" to "Open settings",
        "stopped" to "The extension stopped (exit code {0}). Details are in the IDE log.",
        "restart" to "Restart",
        "noJcef" to "This IDE runs without JCEF, the embedded browser the panel needs.",
        "nodePath" to "Node.js executable:",
        "nodePathHint" to "Leave empty to use the node found on PATH.",
        "editedInPanel" to "Edited from the settings page of the panel.",
        "beta" to "Beta: the IntelliJ version runs the same extension as VS Code, through a compatibility layer."
    )
    private val all = mapOf(
        "fr" to mapOf(
            "nodeMissing" to "Node.js est introuvable. Installez Node.js 18 ou plus récent, ou indiquez son exécutable dans Paramètres, Outils, {0}.",
            "openSettings" to "Ouvrir les paramètres",
            "stopped" to "L'extension s'est arrêtée (code {0}). Le détail est dans le journal de l'IDE.",
            "restart" to "Redémarrer",
            "noJcef" to "Cet IDE tourne sans JCEF, le navigateur intégré dont le panneau a besoin.",
            "nodePath" to "Exécutable Node.js :",
            "nodePathHint" to "Laissez vide pour utiliser le node trouvé dans le PATH.",
            "editedInPanel" to "Se règle depuis la page de paramètres du panneau.",
            "beta" to "Bêta : la version IntelliJ exécute la même extension que VS Code, à travers une couche de compatibilité."
        ),
        "es" to mapOf(
            "nodeMissing" to "No se encontró Node.js. Instale Node.js 18 o posterior, o elija su ejecutable en Ajustes, Herramientas, {0}.",
            "openSettings" to "Abrir ajustes",
            "stopped" to "La extensión se detuvo (código {0}). Los detalles están en el registro del IDE.",
            "restart" to "Reiniciar",
            "noJcef" to "Este IDE funciona sin JCEF, el navegador integrado que necesita el panel.",
            "nodePath" to "Ejecutable de Node.js:",
            "nodePathHint" to "Déjelo vacío para usar el node del PATH.",
            "editedInPanel" to "Se ajusta desde la página de ajustes del panel.",
            "beta" to "Beta: la versión IntelliJ ejecuta la misma extensión que VS Code, mediante una capa de compatibilidad."
        ),
        "de" to mapOf(
            "nodeMissing" to "Node.js wurde nicht gefunden. Installieren Sie Node.js 18 oder neuer, oder wählen Sie die ausführbare Datei unter Einstellungen, Tools, {0}.",
            "openSettings" to "Einstellungen öffnen",
            "stopped" to "Die Erweiterung wurde beendet (Code {0}). Details stehen im IDE-Protokoll.",
            "restart" to "Neu starten",
            "noJcef" to "Diese IDE läuft ohne JCEF, den eingebetteten Browser, den das Panel benötigt.",
            "nodePath" to "Node.js-Programmdatei:",
            "nodePathHint" to "Leer lassen, um das node aus dem PATH zu verwenden.",
            "editedInPanel" to "Wird auf der Einstellungsseite des Panels festgelegt.",
            "beta" to "Beta: Die IntelliJ-Version führt dieselbe Erweiterung wie VS Code aus, über eine Kompatibilitätsschicht."
        ),
        "pt" to mapOf(
            "nodeMissing" to "O Node.js não foi encontrado. Instale o Node.js 18 ou mais recente, ou escolha o executável em Configurações, Ferramentas, {0}.",
            "openSettings" to "Abrir configurações",
            "stopped" to "A extensão parou (código {0}). Os detalhes estão no registro do IDE.",
            "restart" to "Reiniciar",
            "noJcef" to "Este IDE funciona sem JCEF, o navegador integrado de que o painel precisa.",
            "nodePath" to "Executável do Node.js:",
            "nodePathHint" to "Deixe vazio para usar o node encontrado no PATH.",
            "editedInPanel" to "Ajustado na página de configurações do painel.",
            "beta" to "Beta: a versão IntelliJ executa a mesma extensão do VS Code, por meio de uma camada de compatibilidade."
        )
    )

    fun t(key: String, vararg args: Any?): String {
        val lang = Plugin.language.substringBefore('-')
        val s = all[lang]?.get(key) ?: en[key] ?: key
        return s.replace(Regex("\\{(\\d)\\}")) { m -> args.getOrNull(m.groupValues[1].toInt())?.toString() ?: m.value }
    }
}
