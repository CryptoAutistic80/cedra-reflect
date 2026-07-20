/// O(1) magnified-dividend arithmetic for reflection-core.
module reflection_core::reflection_math {
    const E_NEGATIVE_RESULT: u64 = 1;
    const E_UNDERFLOW: u64 = 2;

    /// Enough precision to retain fee division dust while keeping all
    /// intermediate index and correction arithmetic in u256.
    const MAGNITUDE: u256 = 1_000_000_000_000_000_000_000_000;

    /// Compact signed-u256 representation. Move has no native signed integer;
    /// the invariant is canonical zero (negative == false when magnitude == 0).
    struct SignedU256 has copy, drop, store {
        negative: bool,
        magnitude: u256,
    }

    public fun zero(): SignedU256 {
        SignedU256 { negative: false, magnitude: 0 }
    }

    public fun magnitude(): u256 { MAGNITUDE }

    /// Read-only canonical representation for views, snapshots, and the
    /// independent accounting witness.
    public fun parts(value: SignedU256): (bool, u256) {
        (value.negative, value.magnitude)
    }

    public fun add_unsigned(value: &mut SignedU256, amount: u256) {
        if (amount == 0) return;
        if (value.negative) {
            if (value.magnitude > amount) {
                value.magnitude = value.magnitude - amount;
            } else if (value.magnitude < amount) {
                value.negative = false;
                value.magnitude = amount - value.magnitude;
            } else {
                value.negative = false;
                value.magnitude = 0;
            }
        } else {
            value.magnitude = value.magnitude + amount;
        }
    }

    public fun subtract_unsigned(value: &mut SignedU256, amount: u256) {
        if (amount == 0) return;
        if (value.negative) {
            value.magnitude = value.magnitude + amount;
        } else if (value.magnitude > amount) {
            value.magnitude = value.magnitude - amount;
        } else if (value.magnitude < amount) {
            value.negative = true;
            value.magnitude = amount - value.magnitude;
        } else {
            value.magnitude = 0;
        }
    }

    /// Adds the signed correction to a non-negative magnified balance.
    public fun apply(base: u256, correction: SignedU256): u256 {
        if (correction.negative) {
            assert!(base >= correction.magnitude, E_NEGATIVE_RESULT);
            base - correction.magnitude
        } else {
            base + correction.magnitude
        }
    }

    public fun checked_subtract(left: u256, right: u256): u256 {
        assert!(left >= right, E_UNDERFLOW);
        left - right
    }

    #[test]
    fun signed_corrections_are_canonical() {
        let value = zero();
        subtract_unsigned(&mut value, 10);
        assert!(apply(20, value) == 10, 10);
        add_unsigned(&mut value, 10);
        assert!(apply(20, value) == 20, 11);
    }
}
