package net.dangish.evogent;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
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
    private static final Pattern VID = Pattern.compile(
            "(?:v=|/shorts/|youtu\\.be/|/embed/|/live/)([A-Za-z0-9_-]{11})");

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        final Intent intent = getIntent();
        final String text = intent != null ? intent.getStringExtra(Intent.EXTRA_TEXT) : null;
        final String subject = intent != null ? intent.getStringExtra(Intent.EXTRA_SUBJECT) : null;
        Log.i(TAG, "share received text=" + text + " subject=" + subject);
        new Thread(new Runnable() {
            @Override public void run() { ingest(text, subject); }
        }).start();
        finish();
    }

    private void ingest(String text, String subject) {
        try {
            if (text == null) { Log.e(TAG, "no EXTRA_TEXT"); return; }
            Matcher m = VID.matcher(text);
            if (!m.find()) { Log.e(TAG, "no videoId in: " + text); return; }
            String id = m.group(1);
            // Title: prefer the subject; else the text with the URL stripped; else the id.
            String title = subject != null && subject.trim().length() > 0
                    ? subject.trim()
                    : text.replaceAll("https?://\\S+", "").trim();
            if (title.isEmpty()) title = "YouTube video " + id;
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
            body.put("triggeredBy", "phone-browse");   // how it was acquired (diagnosability)
            body.put("startedAtMs", now);
            body.put("completedAtMs", now);
            body.put("status", "completed");
            body.put("itemsAdded", 1);
            body.put("items", new JSONArray().put(item));

            HttpURLConnection c = (HttpURLConnection)
                    new URL("http://localhost:3001/api/internal/browse-cache/submit").openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestProperty("Content-Type", "application/json");
            OutputStream os = c.getOutputStream();
            os.write(body.toString().getBytes("UTF-8"));
            os.close();
            int code = c.getResponseCode();
            Log.i(TAG, "cache id=" + id + " title=\"" + title + "\" -> HTTP " + code);
            c.disconnect();
        } catch (Throwable t) {
            Log.e(TAG, "cache submit failed", t);
        }
    }
}
