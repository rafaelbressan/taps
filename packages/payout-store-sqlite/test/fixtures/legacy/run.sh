#!/bin/bash
# $1 = jar, $2 = nome, $3 = "upgraded"|"old"
set -e
JAR=$1; NAME=$2; SHAPE=$3
DIR=/tmp/h2/out/$NAME
rm -rf "$DIR"; mkdir -p "$DIR"
URL="jdbc:h2:$DIR/tapsDB;MODE=MySQL"
# -continueOnError espelha o <cftry> do CFML: cada CREATE/ALTER do
# environment.cfc e do database.cfc está dentro de um try que engole a
# falha. Uma PK que o H2 recusa simplesmente não existe no banco do baker.
run() { java -cp "$JAR" org.h2.tools.RunScript -url "$URL" -user sa -script "$1" -continueOnError; }
run /tmp/h2/gen/base.sql
if [ "$SHAPE" = "upgraded" ]; then run /tmp/h2/gen/upgrade.sql; run /tmp/h2/gen/data-upgraded.sql;
else run /tmp/h2/gen/data-old.sql; fi
java -cp "$JAR" org.h2.tools.Script -url "$URL" -user sa -script "$DIR/taps-export.sql"
echo "gerado $DIR/taps-export.sql ($(wc -l < "$DIR/taps-export.sql") linhas)"
