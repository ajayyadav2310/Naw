#!/usr/bin/env bash
# Compiles and runs the pure-Java transaction parser tests with the plain JDK.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
javac -encoding UTF-8 -d "$OUT" \
  android-native/app/src/main/java/com/moneytrack/personal/TransactionParser.java \
  tests/java/TransactionParserTest.java
java -cp "$OUT" TransactionParserTest
