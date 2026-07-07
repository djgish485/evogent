package net.dangish.evogent;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Native app drawer for the Evogent launcher: lists every installed app that
 * has a launcher entry and opens it on tap. This is the "quick way to the
 * normal Android app listing" while the Evogent feed stays the home screen.
 */
public class AppDrawerActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final PackageManager pm = getPackageManager();
        Intent launcherFilter = new Intent(Intent.ACTION_MAIN, null);
        launcherFilter.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(launcherFilter, 0);
        Collections.sort(apps, new Comparator<ResolveInfo>() {
            @Override
            public int compare(ResolveInfo a, ResolveInfo b) {
                return a.loadLabel(pm).toString().compareToIgnoreCase(b.loadLabel(pm).toString());
            }
        });

        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setBackgroundColor(Color.parseColor("#0F1115"));
        list.setPadding(0, dp(28), 0, dp(28));

        TextView title = new TextView(this);
        title.setText("Apps");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setPadding(dp(20), dp(8), dp(20), dp(16));
        list.addView(title);

        String myPackage = getPackageName();
        for (final ResolveInfo ri : apps) {
            final String pkg = ri.activityInfo.packageName;
            if (pkg.equals(myPackage)) {
                continue; // don't list Evogent itself; it's already home
            }
            list.addView(buildRow(pm, ri, pkg));
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#0F1115"));
        scroll.addView(list);
        setContentView(scroll);
    }

    private View buildRow(final PackageManager pm, ResolveInfo ri, final String pkg) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(20), dp(12), dp(20), dp(12));
        row.setClickable(true);
        row.setBackgroundColor(Color.TRANSPARENT);

        ImageView icon = new ImageView(this);
        try {
            Drawable d = ri.loadIcon(pm);
            icon.setImageDrawable(d);
        } catch (Exception ignored) {
        }
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(dp(44), dp(44));
        ip.rightMargin = dp(16);
        icon.setLayoutParams(ip);
        row.addView(icon);

        TextView label = new TextView(this);
        label.setText(ri.loadLabel(pm));
        label.setTextColor(Color.parseColor("#E6E8EE"));
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        row.addView(label);

        row.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent launch = pm.getLaunchIntentForPackage(pkg);
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(launch);
                    finish(); // return to the feed after opening the app
                }
            }
        });
        return row;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
