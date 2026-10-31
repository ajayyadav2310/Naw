package com.moneytrack.personal;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Heuristic parser for Indian bank / UPI alert text (SMS or notification).
 *
 * Pure Java on purpose (no Android classes) so it can be unit-tested with a plain JDK.
 * It never sees OTPs: any message that mentions an OTP / verification code is rejected.
 */
public final class TransactionParser {

    public static final class Result {
        public final double amount;
        public final String direction;     // "income" or "expense"
        public final String reference;     // UTR / RRN / ref no, or ""
        public final String counterparty;  // best-effort payee/payer or VPA, or ""

        Result(double amount, String direction, String reference, String counterparty) {
            this.amount = amount;
            this.direction = direction;
            this.reference = reference;
            this.counterparty = counterparty;
        }
    }

    private TransactionParser() {}

    // \u20B9 is the rupee sign; escaped so source encoding can never corrupt it.
    private static final Pattern AMOUNT = Pattern.compile(
        "(?i)(?<![A-Za-z])(?:\\u20B9|rs\\.?|inr)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)"
        + "|([0-9][0-9,]*(?:\\.[0-9]{1,2})?)\\s*(?:inr\\b|rs\\b\\.?|rupees\\b)");

    private static final Pattern CREDIT = Pattern.compile(
        "(?i)\\b(credited|received|deposited|refunded|refund)\\b");
    private static final Pattern DEBIT = Pattern.compile(
        "(?i)\\b(debited|withdrawn|spent|paid|sent|purchase|deducted)\\b");

    private static final Pattern OTP = Pattern.compile(
        "(?i)\\botp\\b|one[- ]time password|verification code|\\bcvv\\b|\\bpin\\b is");
    private static final Pattern FAILED = Pattern.compile(
        "(?i)\\b(failed|declined|unsuccessful|not successful|insufficient)\\b");
    private static final Pattern REQUEST = Pattern.compile(
        "(?i)\\b(collect request|payment request|requested|request from|requests? you)\\b");
    private static final Pattern FUTURE = Pattern.compile(
        "(?i)\\b(will be|to be|shall be|may be|would be)\\s+(debited|credited|deducted|charged)");

    private static final Pattern REF = Pattern.compile(
        "(?i)\\b(?:utr|rrn|upi\\s*ref(?:erence)?|ref(?:erence)?|txn\\s*(?:id|no))"
        + "(?:\\s*(?:no|number|id)\\b\\.?)?\\s*[:#\\-]?\\s*([A-Za-z0-9]{6,})");

    private static final Pattern VPA = Pattern.compile(
        "([A-Za-z0-9._\\-]{2,}@[A-Za-z][A-Za-z0-9.\\-]{1,})");

    private static final Pattern NAME = Pattern.compile(
        "(?i)\\b(?:to|from|by)\\s+(?:vpa\\s+)?([A-Za-z][A-Za-z0-9 .&'\\-]{1,40}?)"
        + "(?=\\s+(?:on|via|ref|upi|utr|using|a/c|ac|avl|bal|rrn|txn|for|dated)\\b|\\s*[.,;(\\[]|\\s+[0-9]|$)");

    public static Result parse(String body) {
        if (body == null) return null;
        String text = body.trim();
        if (text.length() < 12) return null;

        if (OTP.matcher(text).find()) return null;
        if (FAILED.matcher(text).find()) return null;
        if (REQUEST.matcher(text).find()) return null;
        if (FUTURE.matcher(text).find()) return null;

        Double amount = findAmount(text);
        if (amount == null || amount <= 0) return null;

        int creditAt = firstIndex(CREDIT, text);
        int debitAt = firstIndex(DEBIT, text);
        String direction;
        if (creditAt < 0 && debitAt < 0) return null;
        else if (creditAt < 0) direction = "expense";
        else if (debitAt < 0) direction = "income";
        else direction = creditAt < debitAt ? "income" : "expense";

        return new Result(amount, direction, findReference(text), findCounterparty(text));
    }

    private static int firstIndex(Pattern p, String s) {
        Matcher m = p.matcher(s);
        return m.find() ? m.start() : -1;
    }

    /** First amount that is not an available-balance / limit figure. */
    private static Double findAmount(String text) {
        Matcher m = AMOUNT.matcher(text);
        int prevEnd = 0;
        while (m.find()) {
            int from = Math.max(prevEnd, Math.max(0, m.start() - 25));
            String before = text.substring(from, m.start()).toLowerCase();
            prevEnd = m.end();
            if (before.contains("bal") || before.contains("avl") || before.contains("avail")
                || before.contains("limit") || before.contains("closing")) {
                continue;
            }
            String raw = m.group(1) != null ? m.group(1) : m.group(2);
            try {
                double value = Double.parseDouble(raw.replace(",", ""));
                if (value > 0 && value < 1.0e10) return value;
            } catch (NumberFormatException ignored) {
                // try the next candidate
            }
        }
        return null;
    }

    private static String findReference(String text) {
        Matcher m = REF.matcher(text);
        while (m.find()) {
            String candidate = m.group(1);
            if (candidate != null && candidate.matches(".*[0-9].*")) return candidate;
        }
        return "";
    }

    private static String findCounterparty(String text) {
        Matcher n = NAME.matcher(text);
        while (n.find()) {
            String name = n.group(1).trim();
            String lower = name.toLowerCase();
            if (lower.startsWith("a/c") || lower.startsWith("ac ") || lower.startsWith("your")
                || lower.startsWith("account") || lower.startsWith("bank") || lower.startsWith("the ")
                || lower.startsWith("xx") || lower.equals("you") || lower.length() < 2) {
                continue;
            }
            if (name.length() > 40) name = name.substring(0, 40);
            return name;
        }
        Matcher v = VPA.matcher(text);
        return v.find() ? v.group(1) : "";
    }
}
