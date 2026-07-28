package net.dangish.evogent;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Share target: when the background computer-use loop shares a video from the
 * real YouTube app to Evogent, the ACTION_SEND intent lands here with the real
 * watch URL (and usually the title as the subject). We parse the videoId, post
 * it to the local dev-ingest endpoint so it becomes a real, playable feed card,
 * and finish immediately with no UI. No API, no scraping — the URL came from
 * driving the actual logged-in app.
 */
public class ShareReceiverActivity extends Activity {
    private static final String TAG = "EvogentShare";
    private static final int MAX_ITEM_TEXT_CHARS = 4000;
    private static final String BENCHMARK_SHARE_TRIGGERED_BY =
            "phone-benchmark-full-browse-share";
    private static final String BENCHMARK_SHARE_PROOF_KIND = "full_browse_share";
    private static final Pattern VIDEO_URL = Pattern.compile(
            "https?://(?:(?:www\\.|m\\.|music\\.)?youtube\\.com/"
            + "(?:watch\\?(?:[^\\s#&]*&)*v=|shorts/|embed/|live/)|youtu\\.be/)"
            + "([A-Za-z0-9_-]{11})",
            Pattern.CASE_INSENSITIVE);
    // A tweet permalink: (x|twitter|mobile.twitter).com/<handle>/status/<id>. The X app's
    // "Share -> Evogent" sends exactly this, which the accessibility scrape can NEVER read
    // (the status id isn't in X's a11y tree) — so this is the only way to capture the real tweet.
    private static final Pattern TWEET = Pattern.compile(
            "https?://(?:mobile\\.)?(?:x|twitter)\\.com/([A-Za-z0-9_]{1,15})/status/(\\d+)",
            Pattern.CASE_INSENSITIVE);

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        final Intent intent = getIntent();
        final String text;
        final String subject;
        try {
            CharSequence rawText = intent != null
                    ? intent.getCharSequenceExtra(Intent.EXTRA_TEXT) : null;
            CharSequence rawSubject = intent != null
                    ? intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT) : null;
            text = rawText == null ? null : rawText.toString();
            subject = rawSubject == null ? null : rawSubject.toString();
        } catch (Throwable malformedExtra) {
            Log.w(TAG, "rejected share with malformed extras");
            finish();
            return;
        }
        if (intent == null || !EvogentSecurityPolicy.isValidTextShare(
                intent.getAction(), intent.getType(), text, subject)) {
            Log.w(TAG, "rejected invalid or oversized text share");
            finish();
            return;
        }
        // Shared text can contain private notification/content data; log only bounded metadata.
        Log.i(TAG, "accepted text share chars=" + text.length()
                + " subjectChars=" + (subject == null ? 0 : subject.length()));
        final boolean isTweet = TWEET.matcher(text).find();
        final boolean isYoutube = !isTweet && VIDEO_URL.matcher(text).find();
        // Consume the one-shot provenance synchronously in the receiving activity, before its
        // asynchronous HTTP work. Tweets and unsupported shares leave a YouTube benchmark arm
        // untouched; ordinary YouTube shares simply see no arm and retain their original shape.
        final EvogentBenchmarkShareProvenance.Consumed benchmarkProof = isYoutube
                ? EvogentBenchmarkShareProvenance.consume(this, System.currentTimeMillis())
                : null;
        new Thread(new Runnable() {
            @Override public void run() {
                if (isTweet) ingestTweet(text, subject);
                else ingest(text, subject, benchmarkProof);
            }
        }).start();
        finish();
    }

    /** A shared tweet permalink -> browse cache as source=twitter with the REAL /status/ URL. */
    private void ingestTweet(String text, String subject) {
        try {
            Matcher m = TWEET.matcher(text);
            if (!m.find()) { Log.e(TAG, "no supported tweet permalink"); return; }
            String handle = m.group(1);
            String statusId = m.group(2);
            String url = "https://x.com/" + handle + "/status/" + statusId;
            // Tweet text: the subject, else the shared text with the URL(s) stripped. X often
            // shares just the URL, in which case body stays empty and enrichment fills it later.
            String body = subject != null && subject.trim().length() > 0
                    ? subject.trim()
                    : text.replaceAll("https?://\\S+", "").trim();
            body = bounded(body, MAX_ITEM_TEXT_CHARS);
            long now = System.currentTimeMillis();

            JSONObject payload = new JSONObject();
            payload.put("type", "tweet");
            payload.put("statusId", statusId);
            payload.put("authorUsername", handle);
            if (!body.isEmpty()) payload.put("text", body);
            payload.put("url", url);
            payload.put("captureMethod", "phone-share-capture");

            JSONObject item = new JSONObject();
            // sourceId = "tweet-<statusId>" so the curator/enrichment resolve the real permalink
            // (resolveTweetIdentifier parses tweet-<digits>) — this is what makes tap-through open
            // the exact tweet instead of the author profile.
            item.put("sourceId", "tweet-" + statusId);
            item.put("url", url);
            item.put("title", body.isEmpty() ? ("Tweet by @" + handle) : body.substring(0, Math.min(80, body.length())));
            item.put("authorUsername", handle);
            item.put("payload", payload);
            item.put("fetchedAtMs", now);
            item.put("expiresAtMs", now + 14L * 24 * 60 * 60 * 1000);

            JSONObject reqBody = new JSONObject();
            reqBody.put("source", "twitter");
            reqBody.put("triggeredBy", "phone-share-capture");
            reqBody.put("startedAtMs", now);
            reqBody.put("completedAtMs", now);
            reqBody.put("status", "completed");
            reqBody.put("itemsAdded", 1);
            reqBody.put("items", new JSONArray().put(item));

            postCache(reqBody, "tweet");
        } catch (Throwable t) {
            Log.e(TAG, "tweet cache submit failed", t);
        }
    }

    private void postCache(JSONObject body, String label) throws Exception {
        int code = EvogentLoopbackAuth.postJsonDirect(
                this,
                EvogentSecurityPolicy.BROWSE_CACHE_SUBMIT_URL,
                body.toString(),
                8000,
                8000);
        Log.i(TAG, "cache " + label + " -> HTTP " + code);
    }

    private void ingest(
            String text,
            String subject,
            EvogentBenchmarkShareProvenance.Consumed benchmarkProof) {
        try {
            if (text == null) { Log.e(TAG, "no share text"); return; }
            Matcher m = VIDEO_URL.matcher(text);
            if (!m.find()) { Log.e(TAG, "no supported YouTube URL"); return; }
            String id = m.group(1);
            // Title: prefer the subject; else the text with the URL stripped; else the id.
            String title = subject != null && subject.trim().length() > 0
                    ? subject.trim()
                    : text.replaceAll("https?://\\S+", "").trim();
            if (title.isEmpty()) title = "YouTube video " + id;
            title = bounded(title, 500);
            String url = "https://www.youtube.com/watch?v=" + id;
            String thumb = "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";

            // Write into the browse CACHE, not straight to the feed. The phone is the new
            // acquisition layer (replacing the VM's headless-Chrome cache skills); the curator
            // reads this cache and decides what reaches the feed — restoring the app's core law
            // "every feed item is a curator decision." IMPORTANT: use the BASE source name the
            // curator actually reads per installed source skill ('youtube'), NOT a '-phone' suffix
            // — curate.md reads GET browse-cache/items?source=youtube, so a suffixed source is
            // silently ignored. Diagnosability lives in the run's triggeredBy + payload.captureMethod.
            long now = System.currentTimeMillis();

            JSONObject payload = new JSONObject();     // rich per-item content the curator reads
            payload.put("type", "youtube");
            payload.put("videoId", id);
            payload.put("title", title);
            payload.put("url", url);
            payload.put("thumbnailUrl", thumb);
            payload.put("captureMethod", "phone-background-browse");

            JSONObject item = new JSONObject();
            item.put("sourceId", id);
            item.put("url", url);
            item.put("title", title);
            item.put("payload", payload);
            item.put("fetchedAtMs", now);
            item.put("expiresAtMs", now + 14L * 24 * 60 * 60 * 1000); // 14-day TTL in cache

            JSONObject body = new JSONObject();
            body.put("source", "youtube");            // base source the curator reads
            body.put("triggeredBy", benchmarkProof == null
                    ? "phone-browse"
                    : BENCHMARK_SHARE_TRIGGERED_BY);
            body.put("startedAtMs", now);
            body.put("completedAtMs", now);
            body.put("status", "completed");
            body.put("itemsAdded", 1);
            body.put("items", new JSONArray().put(item));
            if (benchmarkProof != null) {
                String sourceIdDigest = EvogentBenchmarkSharePolicy.sha256Hex(id);
                JSONObject proof = new JSONObject();
                proof.put("schemaVersion", 1);
                proof.put("kind", BENCHMARK_SHARE_PROOF_KIND);
                proof.put("benchmarkRunId", benchmarkProof.benchmarkRunId);
                proof.put("sequence", benchmarkProof.sequence);
                proof.put("receiptId", benchmarkProof.receiptId);
                proof.put("tokenDigest", benchmarkProof.tokenDigest);
                proof.put("sourceIdDigest", sourceIdDigest);
                proof.put("armedAtMs", benchmarkProof.armedAtMs);
                proof.put("fetchedAtMs", now);
                body.put("runId", benchmarkProof.receiptId);
                body.put("metadata", new JSONObject().put("benchmarkShareProof", proof));
            }

            postCache(body, "youtube");
        } catch (Throwable t) {
            Log.e(TAG, "cache submit failed", t);
        }
    }

    private static String bounded(String value, int maxChars) {
        if (value == null || value.length() <= maxChars) return value;
        return value.substring(0, maxChars);
    }
}
