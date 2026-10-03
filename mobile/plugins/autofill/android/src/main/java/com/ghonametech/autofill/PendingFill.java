package com.ghonametech.autofill;

import android.os.Build;
import androidx.annotation.RequiresApi;

/**
 * The one request the app is answering right now, handed from the activity
 * that Android launched to the plugin the web app talks to.
 *
 * Static because the two sides are in the same process but have no reference
 * to each other, and because only one fill can be in flight: Android shows a
 * single authentication activity at a time and waits for its result.
 */
@RequiresApi(api = Build.VERSION_CODES.O)
public final class PendingFill {

    public enum Kind {
        /** Android asked us to fill fields on screen. */
        FILL,
        /** Android is offering to store a password the user just typed. */
        SAVE,
    }

    private static PendingFill current;

    public final Kind kind;
    public final FillRequestFields fields;
    /** For a save request: what the user typed, so the app can store it. */
    public final String username;
    public final String password;

    private PendingFill(Kind kind, FillRequestFields fields, String username, String password) {
        this.kind = kind;
        this.fields = fields;
        this.username = username;
        this.password = password;
    }

    public static void setFill(FillRequestFields fields) {
        current = new PendingFill(Kind.FILL, fields, null, null);
    }

    public static void setSave(FillRequestFields fields, String username, String password) {
        current = new PendingFill(Kind.SAVE, fields, username, password);
    }

    public static PendingFill take() {
        return current;
    }

    /** Called when the activity finishes, so nothing is left behind in memory. */
    public static void clear() {
        current = null;
    }
}
