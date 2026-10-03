# test-voix-anglais

Test de faisabilité : conversation orale en temps réel avec **Teacher Joe**, un professeur d'anglais propulsé par l'API Gemini Live, depuis Chrome sur Android.

Page publiée (une fois GitHub Pages activé) : **https://ahiankonoujoseph102-wq.github.io/test-voix-anglais/**

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | La page : champ de clé, bouton, visage SVG, sous-titres, tableau de mesures |
| `app.js` | Connexion WebSocket à Gemini Live, micro, lecture audio, minutage, mesures |
| `mic-worklet.js` | Convertit le micro en PCM 16 bits mono 16 kHz (format exigé par l'API) |
| `style.css` | Mise en page mobile, thème clair ou sombre |

Pas de serveur, pas de compilation, pas de dépendance.

## Utilisation

1. Ouvrir la page dans Chrome sur le téléphone.
2. Coller la clé API Gemini (créée sur https://aistudio.google.com/apikey).
3. Appuyer sur « Commencer la séance » et autoriser le micro.
4. Parler. Avec des écouteurs, on peut décocher « Couper le micro pendant que Teacher Joe parle » pour pouvoir l'interrompre.
5. À la fin (5 minutes, ou bouton « Arrêter »), le tableau de mesures s'affiche. « Copier les mesures (JSON) » permet de les coller ailleurs.

### La clé API

- Elle n'existe que dans la mémoire de la page. Elle n'est ni enregistrée (pas de localStorage, pas de cookie) ni écrite dans le dépôt.
- La page déclare une politique de sécurité (CSP) qui n'autorise qu'une seule connexion sortante : `wss://generativelanguage.googleapis.com`. Le navigateur bloque toute autre destination.
- Limite connue : la clé passe dans l'adresse de la connexion WebSocket, comme dans les exemples officiels. Pour un vrai produit, Google recommande des **jetons éphémères** fabriqués par un petit serveur, pour ne jamais confier la clé au téléphone.

## Fonctionnement technique

- Modèle par défaut : `gemini-3.8-live`. Le menu propose aussi `gemini-3.1-flash-live-preview` et `gemini-2.5-flash-native-audio-preview-12-2025` (anciens modèles), au cas où le premier serait refusé.
- Point d'accès : `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`
- Audio envoyé : PCM 16 bits, mono, 16 kHz, little-endian (`audio/pcm;rate=16000`), par paquets de 100 ms.
- Audio reçu : PCM 16 bits, mono, 24 kHz.
- Sous-titres : `outputAudioTranscription` (Teacher Joe) et `inputAudioTranscription` (l'apprenant, en gris).
- Minutage : la consigne système annonce 5 minutes. La page envoie des notes au modèle à 4:00 (« il reste une minute ») et à 4:30 (« conclus »), puis ferme la connexion à 5:00.
- Bouche : un `AnalyserNode` mesure le volume de la voix jouée ; la hauteur de l'ellipse suit ce volume.
- Délai de réponse : temps entre le dernier son détecté au micro de l'apprenant et le premier son de la réponse. Il inclut le temps que met le serveur à décider que l'apprenant a fini de parler. La détection côté téléphone est approximative (seuil de volume).
- Jetons : la page additionne tous les `usageMetadata` envoyés par l'API et garde aussi le dernier reçu, détaillés par modalité (texte, audio). Elle affiche aussi une estimation indépendante, basée sur la durée audio (32 jetons par seconde).

### Ce qui a été vérifié ici

- Page testée dans Chromium (Playwright) avec un micro simulé et un faux serveur Gemini : configuration envoyée, audio du micro au bon format, notes de minutage à l'heure, sous-titres, bouche animée, coupure à la fin, tableau de mesures, aucune erreur JavaScript.
- Le vrai point d'accès Google répond : avec une fausse clé il ferme la connexion avec le code 1007 « API key not valid ». La page affiche ce message dans la liste des erreurs.
- **Non vérifié** : une vraie conversation avec une vraie clé sur un vrai téléphone Android. C'est l'objet de votre test.

## Activer GitHub Pages depuis un téléphone

L'application mobile GitHub ne propose pas ce réglage ; il faut passer par Chrome.

1. Ouvrir https://github.com/ahiankonoujoseph102-wq/test-voix-anglais/settings/pages dans Chrome (se connecter si besoin ; si la page est trop serrée, menu ⋮ → « Version pour ordinateur »).
2. Section **Build and deployment** → **Source** : « Deploy from a branch ».
3. **Branch** : choisir `claude/compassionate-shannon-2nbqms` (ou `main` si cette branche y a été fusionnée), dossier `/ (root)`, puis **Save**.
4. Attendre une à deux minutes, puis ouvrir https://ahiankonoujoseph102-wq.github.io/test-voix-anglais/

## Compte rendu

### Où j'ai trouvé les informations (3 octobre 2026)

Mon environnement de travail bloque l'accès direct à `ai.google.dev`. J'ai donc croisé :

- les dépôts officiels de Google sur GitHub : [google-gemini/gemini-skills, fiche Live API](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-live-api-dev/SKILL.md) (modèles, formats audio, limites de session), [le guide de migration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-live-api-dev/references/migration.md), [le cookbook Gemini](https://github.com/google-gemini/cookbook/blob/main/quickstarts/websockets/Get_started_LiveAPI.ipynb) (protocole WebSocket brut, modèle `gemini-3.8-live`), [gemini-live-api-examples](https://github.com/google-gemini/gemini-live-api-examples) (spécifications audio) ;
- les extraits des pages officielles [Tarifs](https://ai.google.dev/gemini-api/docs/pricing), [Gemini 3.8 Live](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live), [Limites de débit](https://ai.google.dev/gemini-api/docs/rate-limits) et [Jetons](https://ai.google.dev/gemini-api/docs/tokens) obtenus par recherche web ;
- un test réel du point d'accès Google (avec une fausse clé).

Les chiffres sont cohérents entre ces sources et plusieurs sites tiers, mais **vérifiez-les sur la [page des tarifs](https://ai.google.dev/gemini-api/docs/pricing) avant toute décision**.

### Ce qui marche

- Connexion directe du navigateur à Gemini Live, sans serveur, avec la clé collée dans la page.
- Micro converti au format exigé, voix jouée sans attendre la fin de la phrase.
- Consigne de Teacher Joe, durée de 5 minutes annoncée, avertissement à 4:00, conclusion à 4:30, coupure à 5:00.
- Sous-titres du professeur et de l'apprenant.
- Visage SVG dont la bouche suit le volume de la voix.
- Tableau de mesures : durée réelle, jetons entrée/sortie (si l'API les envoie), audio envoyé/reçu, délai moyen de réponse, coût estimé, erreurs.

### Limites de la formule gratuite relevées

- `gemini-3.8-live` est **gratuit en entrée et en sortie** sur la formule gratuite, avec des quotas réduits.
- En contrepartie, **Google peut utiliser les données de la formule gratuite pour améliorer ses produits** (ce n'est pas le cas en formule payante). À garder en tête pour la voix d'apprenants réels.
- Sessions simultanées : la documentation indiquait jusqu'à **3 sessions en même temps par projet** (et non par clé). Je n'ai pas trouvé de chiffre récent propre à `gemini-3.8-live` ni de nombre de sessions par jour : les quotas exacts de votre projet s'affichent dans Google AI Studio, page « Rate limit ».
- Limites de session (toutes formules) : **15 minutes** maximum pour une session audio sans compression du contexte, connexion d'environ **10 minutes** au maximum, fenêtre de contexte de 128 000 jetons en entrée.

Conséquence pour une séance de 15 minutes : il faudra activer la **compression du contexte** et la **reprise de session** (le serveur prévient avec un message `goAway` avant de couper). Ce test de 5 minutes n'en a pas besoin.

### Tarifs payants relevés

Source : [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing), ligne Gemini 3.8 Live, relevée le 3 octobre 2026. Prix en dollars US par million de jetons.

| | Texte | Audio | Image / vidéo |
|---|---|---|---|
| Entrée | 0,75 $ | 3,00 $ (≈ 0,005 $/min) | 1,00 $ (≈ 0,002 $/min) |
| Sortie | 4,50 $ | 12,00 $ (≈ 0,018 $/min) | — |

- Un son compte pour **32 jetons par seconde**, soit 1 920 jetons par minute ([page Jetons](https://ai.google.dev/gemini-api/docs/tokens)). Le silence envoyé est facturé comme le reste.
- La page des tarifs annonce des **hausses de prix au 1er janvier 2027** pour plusieurs modèles Gemini ; je n'ai pas pu confirmer si Gemini 3.8 Live est concerné.
- Pour comparaison, l'ancien `gemini-2.5-flash-native-audio` était à 0,50 $ (texte) / 3,00 $ (audio) en entrée et 12,00 $ en sortie audio.

### Estimation du coût d'une séance de 15 minutes (formule payante)

Hypothèse : Teacher Joe parle la moitié du temps, et le micro est coupé pendant qu'il parle (réglage par défaut de la page).

| Poste | Calcul | Coût |
|---|---|---|
| Voix de l'apprenant envoyée | 7,5 min × 1 920 jetons = 14 400 jetons × 3 $/M | 0,04 $ |
| Voix de Teacher Joe | 7,5 min × 1 920 jetons = 14 400 jetons × 12 $/M | 0,17 $ (0,14 $ avec le tarif à la minute) |
| Consigne, notes, sous-titres (texte) | quelques milliers de jetons | < 0,01 $ |
| **Total** | | **environ 0,20 à 0,25 $ par séance** |

Avec le micro ouvert en permanence (écouteurs), compter environ 0,04 $ de plus.

**Réserve importante :** si l'API refacture à chaque tour tout l'historique de la conversation comme jetons d'entrée, le coût grimpe avec la durée : il pourrait atteindre **1 à 3 $** pour 15 minutes. Votre séance de 5 minutes permettra de trancher :

- si « Jetons en entrée (API) » est proche de « Estimation (32 jetons/s) », la facturation est proportionnelle au temps : multipliez le coût de 5 minutes par 3 ;
- s'il est nettement plus grand, et que les jetons d'entrée augmentent d'un tour à l'autre (ligne « premier / dernier tour »), l'historique est refacturé : le coût augmente plus vite que la durée (jusqu'à environ ×9 pour passer de 5 à 15 minutes). La compression du contexte limite alors la hausse.
