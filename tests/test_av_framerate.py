"""Unit tests for PyAV-compatible output framerate normalization."""

from __future__ import annotations

from fractions import Fraction

from services.utils import av_output_framerate


class _MockRational:
    def __init__(self, numerator: int, denominator: int) -> None:
        self.numerator = numerator
        self.denominator = denominator


def test_float_framerate_becomes_millisecond_fraction() -> None:
    assert av_output_framerate(24.0) == Fraction(24000, 1000)


def test_int_framerate_becomes_millisecond_fraction() -> None:
    assert av_output_framerate(30) == Fraction(30000, 1000)


def test_none_uses_default_24fps() -> None:
    assert av_output_framerate(None) == Fraction(24, 1)


def test_fraction_passes_through() -> None:
    rate = Fraction(30000, 1001)
    assert av_output_framerate(rate) == rate


def test_rational_with_numerator_denominator_passes_through() -> None:
    assert av_output_framerate(_MockRational(24, 1)) == Fraction(24, 1)
