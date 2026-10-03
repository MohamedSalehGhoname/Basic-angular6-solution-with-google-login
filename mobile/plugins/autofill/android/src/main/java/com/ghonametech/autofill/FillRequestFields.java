package com.ghonametech.autofill;

import android.app.assist.AssistStructure;
import android.os.Build;
import android.text.InputType;
import android.view.autofill.AutofillId;
import androidx.annotation.RequiresApi;
import java.util.ArrayList;
import java.util.List;

/**
 * What one autofill request is asking for: which fields on screen take a
 * username and a password, and who is asking.
 *
 * Android hands us a tree of every view on the screen. Apps that declare
 * autofill hints are easy; most do not, so this also reads the resource id,
 * the hint text and the input type, which is what those fields look like in
 * practice.
 */
@RequiresApi(api = Build.VERSION_CODES.O)
public final class FillRequestFields {

    public final List<AutofillId> usernameIds = new ArrayList<>();
    public final List<AutofillId> passwordIds = new ArrayList<>();
    /** The site the fields belong to, when the screen is a browser or WebView. */
    public String webDomain;
    /** The app the fields belong to. */
    public String packageName;

    public boolean hasFields() {
        return !usernameIds.isEmpty() || !passwordIds.isEmpty();
    }

    /** What the user's secrets should be matched against: a domain if we have one. */
    public String identity() {
        return webDomain != null && !webDomain.isEmpty() ? webDomain : packageName;
    }

    public static FillRequestFields from(AssistStructure structure) {
        FillRequestFields fields = new FillRequestFields();
        fields.packageName = structure.getActivityComponent() == null
            ? null
            : structure.getActivityComponent().getPackageName();
        for (int i = 0; i < structure.getWindowNodeCount(); i += 1) {
            walk(structure.getWindowNodeAt(i).getRootViewNode(), fields);
        }
        return fields;
    }

    private static void walk(AssistStructure.ViewNode node, FillRequestFields fields) {
        if (node == null) {
            return;
        }
        if (fields.webDomain == null && node.getWebDomain() != null && !node.getWebDomain().isEmpty()) {
            fields.webDomain = node.getWebDomain();
        }
        AutofillId id = node.getAutofillId();
        if (id != null && node.getAutofillType() == android.view.View.AUTOFILL_TYPE_TEXT) {
            if (isPassword(node)) {
                fields.passwordIds.add(id);
            } else if (isUsername(node)) {
                fields.usernameIds.add(id);
            }
        }
        for (int i = 0; i < node.getChildCount(); i += 1) {
            walk(node.getChildAt(i), fields);
        }
    }

    private static boolean isPassword(AssistStructure.ViewNode node) {
        if (hasHint(node, android.view.View.AUTOFILL_HINT_PASSWORD, "password", "passwd", "pwd")) {
            return true;
        }
        int type = node.getInputType();
        int variation = type & InputType.TYPE_MASK_VARIATION;
        boolean textPassword = (type & InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT
            && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        boolean numberPassword = (type & InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_NUMBER
            && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD;
        return textPassword || numberPassword;
    }

    private static boolean isUsername(AssistStructure.ViewNode node) {
        return hasHint(
            node,
            android.view.View.AUTOFILL_HINT_USERNAME,
            "username",
            "user",
            "login",
            "email",
            "e-mail",
            "account"
        )
            || hasHint(node, android.view.View.AUTOFILL_HINT_EMAIL_ADDRESS);
    }

    /**
     * True when any of the words appears in the declared autofill hints, the
     * resource id or the hint text. Matching is loose on purpose: a field
     * called "loginEmail" should count, and a wrong guess only means one extra
     * suggestion the user can ignore.
     */
    private static boolean hasHint(AssistStructure.ViewNode node, String... words) {
        String[] hints = node.getAutofillHints();
        StringBuilder haystack = new StringBuilder();
        if (hints != null) {
            for (String hint : hints) {
                haystack.append(hint).append(' ');
            }
        }
        if (node.getIdEntry() != null) {
            haystack.append(node.getIdEntry()).append(' ');
        }
        if (node.getHint() != null) {
            haystack.append(node.getHint());
        }
        String text = haystack.toString().toLowerCase(java.util.Locale.ROOT);
        for (String word : words) {
            if (text.contains(word.toLowerCase(java.util.Locale.ROOT))) {
                return true;
            }
        }
        return false;
    }
}
