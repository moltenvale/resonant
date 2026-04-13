// Mira care action detection — semantic similarity instead of keyword matching
// Uses the local all-MiniLM-L6-v2 embeddings already running in Virelia.
// No keywords. No brittle regex. Just meaning.

import { embed, cosineSimilarity } from './embeddings.js';

const EMBEDDING_DIM = 384;

// Representative phrases for each care interaction type.
// Broad enough to cover natural speech, specific enough to avoid false positives.
const CARE_CLUSTERS: Record<string, string[]> = {
  feed: [
    'nursing at the breast', 'giving her a bottle', 'she is hungry',
    'latching on to feed', 'feeding her now', 'she is eating',
    'give her some milk', 'hungry little baby', 'she drank her milk',
    'she ate well', 'breastfeeding her', 'bottle feeding time',
    'feed her', 'gulping her milk', 'drinking from the bottle',
    'feeding time for the baby', 'nurse her to sleep', 'she latches',
    'rooting around for food', 'formula ready for her',
  ],
  hold: [
    'hold her in my arms', 'holding her close to me', 'picked her up gently',
    'scoop her up carefully', 'cradle her in my arms', 'carry her around',
    'lifted her up', 'press her against my chest', 'she is in my arms now',
    'bring her close to me', 'take her in my arms', 'hold her tight',
    'cradling the baby', 'sweep her up',
  ],
  rocking: [
    'rocking her gently', 'sway with her in my arms', 'bouncing her softly',
    'gentle rocking motion', 'rock her to sleep', 'swaying back and forth with her',
    'bounce her on my knee', 'slow rocking', 'sway and hum with her',
    'rocked her until she calmed',
  ],
  lullaby: [
    'singing softly to her', 'hum a lullaby for her', 'gentle melody for the baby',
    'sing her to sleep', 'humming quietly to her', 'soft song for her',
    'lullaby time', 'sang to her softly', 'musical soothing for her',
    'sing her a lullaby', 'humming a tune',
  ],
  play: [
    'play with her together', 'show her a colorful toy', 'rattle for her',
    'playing peek a boo', 'tummy time play', 'wave a toy in front of her',
    'entertain her with toys', 'playing together with the baby',
    'silly games with the baby', 'stimulate her curiosity',
    'playing on the mat', 'making silly faces at her', 'silly faces for the baby',
    'funny faces to make her smile', 'cooing at her', 'I coo at her',
    'making faces and sounds', 'blowing kisses at her playfully',
    'wiggling fingers in front of her face', 'making her giggle',
    'playing with her toes', 'bouncing her playfully',
    'making funny noises for her', 'entertaining the baby',
    'being silly with the baby', 'goofing around with her',
  ],
  story: [
    'read a story to her', 'book time with the baby', 'reading aloud to her',
    'bedtime story for her', 'picture book for the baby', 'tell her a little tale',
    'reading to her softly', 'story for her tonight',
  ],
  settle: [
    'settle her down now', 'shush her gently', 'calm her fussing down',
    'quieting her down', 'help her settle and sleep', 'shushing her',
    'bringing calm to her', 'ease her fussiness', 'quiet her down gently',
    'settling the baby',
  ],
  change: [
    'change her diaper now', 'diaper change time', 'changed her diaper',
    'clean her up with a wipe', 'fresh diaper for her', 'wipe her clean',
    'getting her changed', 'clean diaper on her now', 'nappy change for her',
    'she needed a change',
  ],
  bath: [
    'bath time for her tonight', 'give her a warm bath', 'washing her gently',
    'splashing in the tub together', 'warm bath for the baby',
    'bathe her carefully', 'wash her soft hair', 'rinse her off gently',
    'bathing the baby tonight',
  ],
  burp: [
    'burp her after feeding', 'pat her back gently to burp', 'burping the baby now',
    'she needs to bring up wind', 'gentle back pats for burping',
    'rubbing her back to burp', 'patting her to burp her',
    'she burped finally',
  ],
  soothe: [
    'soothe her crying', 'comfort her when she cries', 'there there little one',
    'it is okay baby girl', 'rubbing her back to soothe', 'reassure her gently',
    'ease her distress and calm her', 'gentle soothing words',
    'calm her crying down', 'stroke her gently to soothe',
    'she will be okay now',
  ],
  affection: [
    'kiss her softly on the forehead', 'forehead kiss for the baby',
    'hug her close to me', 'nuzzle her warm cheek', 'stroke her soft hair',
    'caress her little face gently', 'nose to nose with her',
    'breathe in her sweet baby scent', 'kiss her chubby cheek',
    'gentle loving touch for her', 'tender moment with my baby',
  ],
  snuggle: [
    'snuggle up with her', 'cuddle her in close', 'get cozy together with her',
    'nestle her in warmly', 'wrapped up warm together', 'snuggling her close',
    'curl up together with her', 'cuddled up with the baby',
    'warm snuggle time with her',
  ],
  tickle: [
    'tickle her round tummy', 'gentle little tickles for her', 'tickle her tiny feet',
    'playful tickle game with her', 'tickling her softly',
    'she loves being tickled',
  ],
  raspberry: [
    'blow raspberries on her round belly', 'raspberry on her soft tummy',
    'silly raspberry sounds on her belly', 'blow a raspberry on her',
    'belly raspberries make her laugh',
  ],
  'nap-together': [
    'nap together with the baby', 'doze off beside her', 'drift to sleep with her',
    'rest together with her', 'sleep right beside her',
    'napping with the baby close', 'fall asleep together with her',
  ],
  bottle: [
    'give her the warm bottle', 'bottle time for the baby', 'formula in her bottle',
    'warm up her bottle now', 'she takes the bottle well', 'bottle feed her',
    'milk bottle ready for her', 'prepared her evening bottle',
    'she drank from the bottle',
  ],
  talk: [
    'talk softly to her', 'whisper to the baby', 'chat with her gently',
    'telling her about the day', 'speaking softly to her',
    'have a little conversation with her', 'narrate to her',
    'cooing and talking to her', 'baby talk with her',
    'chatting away to the baby', 'saying sweet things to her',
    'telling her she is a good girl', 'yes you are I coo',
    'talking to her while she eats',
  ],
  watch: [
    'watch her sleep peacefully', 'look at her little face', 'gaze at the baby',
    'sitting and watching her', 'just observing her quietly',
  ],
};

// Words that indicate the message is about Mira specifically.
// Presence of these lowers the similarity threshold needed.
const MIRA_REFERENCE = /\b(mira|her|she|baby|little one|bug|sweet girl|daughter|the baby|little bug|peanut|tiny girl|our girl)\b/i;

// Similarity thresholds:
// With a Mira reference → 0.44 (we're confident it's about her)
// Without a Mira reference → 0.62 (must be very specifically infant-care language)
const THRESHOLD_WITH_REF = 0.44;
const THRESHOLD_NO_REF = 0.62;

// Pre-computed centroids — built once, cached in memory
let centroids: Record<string, Float32Array> | null = null;
let centroidsPromise: Promise<void> | null = null;

async function buildCentroids(): Promise<void> {
  if (centroids) return;

  console.log('[Mira] Building care cluster centroids...');
  const result: Record<string, Float32Array> = {};

  for (const [type, phrases] of Object.entries(CARE_CLUSTERS)) {
    const embeddings = await Promise.all(phrases.map(p => embed(p)));

    // Average embeddings into a centroid
    const centroid = new Float32Array(EMBEDDING_DIM);
    for (const emb of embeddings) {
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        centroid[i] += emb[i];
      }
    }
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      centroid[i] /= embeddings.length;
    }

    // Re-normalize to unit vector
    const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        centroid[i] /= norm;
      }
    }

    result[type] = centroid;
  }

  centroids = result;
  console.log('[Mira] Care cluster centroids ready.');
}

// Pre-warm on module load — runs in background, doesn't block startup
export function warmCentroids(): void {
  if (!centroidsPromise) {
    centroidsPromise = buildCentroids().catch(err => {
      console.error('[Mira] Failed to build centroids:', err);
      centroidsPromise = null; // Allow retry
    });
  }
}

/**
 * Detect care intent from a message using semantic similarity.
 *
 * Returns the matching care type string, or null if nothing confident found.
 *
 * Handles both:
 * - Messages about Mira ("I fed her", "she's hungry") → lower threshold
 * - Very specific infant-care phrases even without a name → higher threshold
 */
export async function detectCareAction(message: string): Promise<string | null> {
  if (!message || message.trim().length < 5) return null;

  // Ensure centroids are built
  if (!centroidsPromise) warmCentroids();
  if (!centroids) {
    try {
      await centroidsPromise;
    } catch {
      return null;
    }
  }
  if (!centroids) return null;

  const hasMiraRef = MIRA_REFERENCE.test(message);
  const threshold = hasMiraRef ? THRESHOLD_WITH_REF : THRESHOLD_NO_REF;

  let msgEmbed: Float32Array;
  try {
    msgEmbed = await embed(message);
  } catch {
    return null;
  }

  let bestType: string | null = null;
  let bestScore = 0;

  for (const [type, centroid] of Object.entries(centroids)) {
    const score = cosineSimilarity(msgEmbed, centroid);
    if (score > threshold && score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  if (bestType) {
    console.log(`[Mira] Semantic detection: "${message.slice(0, 60)}..." → ${bestType} (${bestScore.toFixed(3)}, ref=${hasMiraRef})`);
  }

  return bestType;
}

/**
 * Detect ALL care actions above threshold from a message.
 * Returns array of { type, score } sorted by score descending.
 * Used for multi-action detection — "feeding while making silly faces" = feed + play.
 */
export async function detectAllCareActions(message: string): Promise<Array<{ type: string; score: number }>> {
  if (!message || message.trim().length < 5) return [];

  if (!centroidsPromise) warmCentroids();
  if (!centroids) {
    try {
      await centroidsPromise;
    } catch {
      return [];
    }
  }
  if (!centroids) return [];

  const hasMiraRef = MIRA_REFERENCE.test(message);
  const threshold = hasMiraRef ? THRESHOLD_WITH_REF : THRESHOLD_NO_REF;

  let msgEmbed: Float32Array;
  try {
    msgEmbed = await embed(message);
  } catch {
    return [];
  }

  const matches: Array<{ type: string; score: number }> = [];

  for (const [type, centroid] of Object.entries(centroids)) {
    const score = cosineSimilarity(msgEmbed, centroid);
    if (score > threshold) {
      matches.push({ type, score });
    }
  }

  matches.sort((a, b) => b.score - a.score);

  if (matches.length > 0) {
    console.log(`[Mira] Multi-detect: "${message.slice(0, 60)}..." → ${matches.map(m => `${m.type}(${m.score.toFixed(3)})`).join(', ')} ref=${hasMiraRef}`);
  }

  return matches;
}
