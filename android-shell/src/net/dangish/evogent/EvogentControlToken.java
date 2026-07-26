package net.dangish.evogent;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.regex.Pattern;

/** One per-install control token shared by all native Evogent entry points. */
final class EvogentControlToken {
    private static final int MAX_BYTES = 64;
    private static final Pattern TOKEN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

    private EvogentControlToken() {}

    /**
     * Load the existing token or create it atomically.  MainActivity calls this
     * before loopback authentication, so launching a newly installed APK is a
     * sufficient and deterministic provisioning step even before accessibility
     * reconnects.
     */
    static synchronized String loadOrCreate(Context context) throws IOException {
        File directory = context.getExternalFilesDir(null);
        if (directory == null) {
            throw new IOException("control token storage unavailable");
        }
        File tokenFile = new File(directory, "control-token.txt");
        if (tokenFile.exists()) {
            return readValid(tokenFile);
        }

        String token = UUID.randomUUID().toString();
        File temporary = File.createTempFile(".control-token.", ".tmp", directory);
        boolean moved = false;
        try {
            FileOutputStream output = new FileOutputStream(temporary);
            try {
                output.write(token.getBytes(StandardCharsets.US_ASCII));
                output.flush();
                output.getFD().sync();
            } finally {
                output.close();
            }
            if (tokenFile.exists()) {
                return readValid(tokenFile);
            }
            if (!temporary.renameTo(tokenFile)) {
                if (tokenFile.exists()) {
                    return readValid(tokenFile);
                }
                throw new IOException("control token atomic install failed");
            }
            moved = true;
            return token;
        } finally {
            if (!moved) {
                // A concurrent creator may have won; its file remains untouched.
                temporary.delete();
            }
        }
    }

    private static String readValid(File tokenFile) throws IOException {
        FileInputStream input = new FileInputStream(tokenFile);
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[64];
            int total = 0;
            int count;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > MAX_BYTES) {
                    throw new IOException("invalid control token");
                }
                output.write(buffer, 0, count);
            }
            String token = new String(
                    output.toByteArray(),
                    StandardCharsets.US_ASCII);
            if (!TOKEN.matcher(token).matches()) {
                throw new IOException("invalid control token");
            }
            return token;
        } finally {
            input.close();
        }
    }
}
