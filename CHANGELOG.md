# Changelog

## 0.58.0 — 2026-07-28

- **Fix** : le badge de l'onglet de la barre d'activité s'affiche maintenant dès le démarrage, même lorsque l'emplacement est réglé sur « Barre latérale principale ». Le badge est dorénavant porté par la vue `gauge` (TreeView), dont le badge existe dès la création de la vue, contrairement à celui de la webview qui n'apparaît qu'une fois le panneau ouvert.
- **Fix** : le comportement d'auto-déplacement vers la barre latérale secondaire au clic sur l'icône a été désactivé. L'utilisateur conserve son emplacement préféré sans rebond automatique.
