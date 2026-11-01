package io.github.lfrank95.amberwave;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * Ed25519-Unterschrift prüfen (RFC 8032, Abschnitt 5.1.7) – für den Ausweis des Servers. Android bringt Ed25519 erst
 * in neueren Versionen mit, deshalb hier die Referenz aus dem RFC mit BigInteger: langsam (einige Millisekunden), aber
 * nur einmal beim Verbinden nötig. Nur Prüfen, kein Unterschreiben – geheime Schlüssel gibt es in der App nicht.
 */
public final class Ed25519 {
    private Ed25519() {}

    private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
    private static final BigInteger D = BigInteger.valueOf(-121665).multiply(inv(BigInteger.valueOf(121666))).mod(P);
    private static final BigInteger SQRT_M1 = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
    private static final BigInteger[] G;

    static {
        BigInteger gy = BigInteger.valueOf(4).multiply(inv(BigInteger.valueOf(5))).mod(P);
        BigInteger gx = xAus(gy, 0);
        G = new BigInteger[] {gx, gy, BigInteger.ONE, gx.multiply(gy).mod(P)};
    }

    private static BigInteger inv(BigInteger x) {
        return x.modPow(P.subtract(BigInteger.valueOf(2)), P);
    }

    /** Punkte in erweiterten Koordinaten (X, Y, Z, T) */
    private static BigInteger[] add(BigInteger[] a, BigInteger[] b) {
        BigInteger A = a[1].subtract(a[0]).multiply(b[1].subtract(b[0])).mod(P);
        BigInteger B = a[1].add(a[0]).multiply(b[1].add(b[0])).mod(P);
        BigInteger C = BigInteger.valueOf(2).multiply(a[3]).multiply(b[3]).multiply(D).mod(P);
        BigInteger Dd = BigInteger.valueOf(2).multiply(a[2]).multiply(b[2]).mod(P);
        BigInteger E = B.subtract(A), F = Dd.subtract(C), Gg = Dd.add(C), H = B.add(A);
        return new BigInteger[] {E.multiply(F).mod(P), Gg.multiply(H).mod(P), F.multiply(Gg).mod(P), E.multiply(H).mod(P)};
    }

    private static BigInteger[] mul(BigInteger s, BigInteger[] p) {
        BigInteger[] q = {BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO};
        while (s.signum() > 0) {
            if (s.testBit(0)) q = add(q, p);
            p = add(p, p);
            s = s.shiftRight(1);
        }
        return q;
    }

    private static boolean gleich(BigInteger[] a, BigInteger[] b) {
        return a[0].multiply(b[2]).subtract(b[0].multiply(a[2])).mod(P).signum() == 0
            && a[1].multiply(b[2]).subtract(b[1].multiply(a[2])).mod(P).signum() == 0;
    }

    private static BigInteger xAus(BigInteger y, int vorzeichen) {
        if (y.compareTo(P) >= 0) return null;
        BigInteger x2 = y.multiply(y).subtract(BigInteger.ONE).multiply(inv(D.multiply(y).multiply(y).add(BigInteger.ONE))).mod(P);
        if (x2.signum() == 0) return vorzeichen == 0 ? BigInteger.ZERO : null;
        BigInteger x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) x = x.multiply(SQRT_M1).mod(P);
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) return null;
        if (x.testBit(0) != (vorzeichen == 1)) x = P.subtract(x);
        return x;
    }

    private static BigInteger le(byte[] b) {
        byte[] r = new byte[b.length];
        for (int i = 0; i < b.length; i++) r[i] = b[b.length - 1 - i];
        return new BigInteger(1, r);
    }

    private static BigInteger[] entpacken(byte[] s) {
        if (s.length != 32) return null;
        BigInteger y = le(s);
        int vz = y.testBit(255) ? 1 : 0;
        y = y.clearBit(255);
        BigInteger x = xAus(y, vz);
        if (x == null) return null;
        return new BigInteger[] {x, y, BigInteger.ONE, x.multiply(y).mod(P)};
    }

    /** Stimmt die Unterschrift (64 Byte) über die Nachricht zum öffentlichen Schlüssel (32 Byte)? */
    public static boolean pruefen(byte[] schluessel, byte[] nachricht, byte[] unterschrift) {
        try {
            if (schluessel == null || unterschrift == null || schluessel.length != 32 || unterschrift.length != 64) return false;
            BigInteger[] a = entpacken(schluessel);
            byte[] rs = Arrays.copyOfRange(unterschrift, 0, 32);
            BigInteger[] r = entpacken(rs);
            if (a == null || r == null) return false;
            BigInteger s = le(Arrays.copyOfRange(unterschrift, 32, 64));
            if (s.compareTo(L) >= 0) return false;
            MessageDigest md = MessageDigest.getInstance("SHA-512");
            md.update(rs);
            md.update(schluessel);
            md.update(nachricht);
            BigInteger h = le(md.digest()).mod(L);
            return gleich(mul(s, G), add(r, mul(h, a)));
        } catch (Exception e) {
            return false;
        }
    }

    /** Hex → Bytes (null bei ungültiger Eingabe) */
    public static byte[] hex(String h) {
        if (h == null || h.length() % 2 != 0) return null;
        byte[] b = new byte[h.length() / 2];
        for (int i = 0; i < b.length; i++) {
            int hi = Character.digit(h.charAt(2 * i), 16), lo = Character.digit(h.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) return null;
            b[i] = (byte) (hi * 16 + lo);
        }
        return b;
    }
}
