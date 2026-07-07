package net.dangish.evogent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** AlarmManager fires this on the browse interval; it starts a new BrowseService cycle. */
public class BrowseAlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        int count = intent != null ? intent.getIntExtra("count", 5) : 5;
        Log.i("EvoBrowse", "alarm fired -> starting browse cycle");
        Intent svc = new Intent(ctx, BrowseService.class);
        svc.putExtra("count", count);
        ctx.startService(svc);
    }
}
