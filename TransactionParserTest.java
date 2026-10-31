import com.moneytrack.personal.TransactionParser;

/**
 * Dependency-free test runner (plain JDK). Run with scripts/test-java.sh.
 * Every message below is a synthetic example written for this test, not real customer data.
 */
public class TransactionParserTest {
    static int failures = 0;
    static int checks = 0;

    static void expect(String label, boolean ok) {
        checks++;
        if (!ok) { failures++; System.out.println("FAIL: " + label); }
    }

    static void tx(String body, String dir, double amount, String ref) {
        TransactionParser.Result r = TransactionParser.parse(body);
        expect("parse non-null: " + body, r != null);
        if (r == null) return;
        expect("direction (" + r.direction + " != " + dir + "): " + body, dir.equals(r.direction));
        expect("amount (" + r.amount + " != " + amount + "): " + body, Math.abs(r.amount - amount) < 0.001);
        if (ref != null) expect("reference (" + r.reference + " != " + ref + "): " + body, ref.equals(r.reference));
    }

    static void none(String body) {
        expect("should be ignored: " + body, TransactionParser.parse(body) == null);
    }

    public static void main(String[] args) {
        tx("Rs.1,250.50 debited from A/c XX1234 on 12-10-26. UPI Ref No 628712345678. Avl Bal Rs 9,000.00", "expense", 1250.50, "628712345678");
        tx("INR 5,000.00 credited to your A/c XX9876 on 12-Oct-26 by UPI. UTR: SBIN626123456789", "income", 5000.00, "SBIN626123456789");
        tx("₹300 sent from India Post Payments Bank a/c X1234 to RAMESH KUMAR on 01-11-26. Ref 612345678901.", "expense", 300.00, "612345678901");
        tx("Your a/c is credited with Rs. 750 from SURESH. RRN 600011112222", "income", 750.00, "600011112222");
        // Balance mentioned BEFORE the transaction amount must not be used as the amount.
        tx("Avl Bal Rs 12,000.00. Rs 450.00 debited at CAFE on card ending 4321", "expense", 450.00, null);
        tx("Money received: 2,000 rupees credited to your account via UPI", "income", 2000.00, null);

        // Counterparty extraction
        TransactionParser.Result r = TransactionParser.parse("Rs 300 sent from a/c X1234 to RAMESH KUMAR on 01-11-26. Ref 612345678901");
        expect("counterparty RAMESH KUMAR (got " + (r == null ? "null" : r.counterparty) + ")",
            r != null && "RAMESH KUMAR".equals(r.counterparty));
        r = TransactionParser.parse("Rs 80 debited from a/c X1234. Paid to VPA chai@okbank. Ref 612345678901");
        expect("counterparty VPA (got " + (r == null ? "null" : r.counterparty) + ")",
            r != null && r.counterparty.contains("@"));

        // Must be ignored
        none("Your OTP for transaction of Rs 500 is 123456. Do not share it with anyone.");
        none("Rs 500 will be debited from your account on 05-Nov if mandate is approved");
        none("Transaction of Rs 500 failed. Amount not debited.");
        none("Ramesh requested Rs 500 from you on UPI. Approve in your app.");
        none("Hi, your parcel has been sent. Track it now");
        none("Dear customer, your a/c balance is Rs 9,000.00");
        none(null);
        none("");

        System.out.println(checks + " checks, " + failures + " failures");
        if (failures > 0) System.exit(1);
    }
}
