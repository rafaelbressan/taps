#!/usr/bin/env python3
"""Reprova workflow que observa branches onde a branch padrão não está.

O buraco que este script fecha: `.github/workflows/ci.yml` observava
`[main, staging, develop]` num repositório cuja branch padrão é `master`.
Nenhum push e nenhum PR do fluxo real disparava o arquivo, e um workflow que
nunca executou é visualmente indistinguível de um workflow aprovado — foi
nesse ponto cego que 12 erros TS2300 sobreviveram sem ninguém notar (BRES-72).

Um filtro de branch que não casa com a branch padrão é erro, nunca aviso: o
modo de falha é silêncio, e silêncio já custou caro aqui.
"""

from __future__ import annotations

import argparse
import fnmatch
import sys
import tempfile
from pathlib import Path

import yaml

# YAML 1.1 lê a chave nua `on:` como o booleano True. Ler só a string "on"
# devolveria "esse workflow não tem gatilho" para TODO workflow do repositório —
# a checagem passaria sempre, que é exatamente a falha que ela existe para pegar.
ON_KEYS = ("on", True)

EVENTS = ("push", "pull_request")


def _triggers(doc: dict) -> dict:
    for key in ON_KEYS:
        if key in doc:
            value = doc[key]
            # `on: push` ou `on: [push, pull_request]` — sem filtro de branch.
            if isinstance(value, str):
                return {value: None}
            if isinstance(value, list):
                return {item: None for item in value}
            if isinstance(value, dict):
                return value
    return {}


def check_file(path: Path, default_branch: str) -> list[str]:
    """Devolve as violações do arquivo. Lista vazia = aprovado."""
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        return [f"{path}: não é um mapeamento YAML — não dá para verificar os gatilhos."]

    triggers = _triggers(doc)
    if not triggers:
        return [f"{path}: nenhuma chave `on:` encontrada — o workflow não dispara nunca."]

    problems = []
    for event in EVENTS:
        if event not in triggers:
            continue
        config = triggers[event]
        if not isinstance(config, dict):
            continue  # `push:` sem filtro observa todas as branches.

        # Sem `branches:`, todas as branches valem — mas `branches-ignore:` ainda
        # pode excluir a padrão, então as duas chaves são conferidas em separado.
        allowed = config.get("branches")
        if isinstance(allowed, str):
            allowed = [allowed]
        if allowed and not any(fnmatch.fnmatch(default_branch, p) for p in allowed):
            problems.append(
                f"{path}: `on.{event}.branches` = {allowed} não inclui a branch "
                f"padrão `{default_branch}` — este gatilho nunca dispara."
            )

        ignored = config.get("branches-ignore")
        if isinstance(ignored, str):
            ignored = [ignored]
        if ignored and any(fnmatch.fnmatch(default_branch, p) for p in ignored):
            problems.append(
                f"{path}: `on.{event}.branches-ignore` = {ignored} exclui a branch "
                f"padrão `{default_branch}` — este gatilho nunca dispara nela."
            )

    return problems


def scan(workflow_dir: Path, default_branch: str) -> list[str]:
    files = sorted(
        p for p in workflow_dir.iterdir() if p.suffix in (".yml", ".yaml") and p.is_file()
    )
    if not files:
        return [f"{workflow_dir}: nenhum workflow encontrado."]
    return [problem for f in files for problem in check_file(f, default_branch)]


# Uma checagem que não sabe reprovar não é checagem. Este selftest constrói o
# caso ruim — o próprio ci.yml que motivou o BRES-72 — e exige que ele reprove.
SELFTEST_CASES = [
    # (nome, conteúdo, deve_reprovar)
    ("ci-legado-bres-72", "name: CI\non:\n  push:\n    branches: [main, staging, develop]\n  pull_request:\n    branches: [main, staging]\njobs: {}\n", True),
    ("padrao-listada", "name: OK\non:\n  push:\n    branches: [main, master]\n  pull_request:\njobs: {}\n", False),
    ("sem-filtro-de-branch", "name: OK\non:\n  push:\n    paths: ['src/**']\njobs: {}\n", False),
    ("glob-casa", "name: OK\non:\n  push:\n    branches: ['mast*']\njobs: {}\n", False),
    ("padrao-ignorada", "name: Ruim\non:\n  push:\n    branches-ignore: [master]\njobs: {}\n", True),
    ("gatilho-em-lista", "name: OK\non: [push, pull_request]\njobs: {}\n", False),
]


def selftest() -> int:
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name, content, should_fail in SELFTEST_CASES:
            path = Path(tmp) / f"{name}.yml"
            path.write_text(content, encoding="utf-8")
            problems = check_file(path, "master")
            failed = bool(problems)
            if failed != should_fail:
                esperado = "reprovar" if should_fail else "aprovar"
                obtido = "reprovou" if failed else "aprovou"
                print(f"SELFTEST FALHOU: `{name}` deveria {esperado}, e {obtido}.")
                for p in problems:
                    print(f"    {p}")
                failures += 1
            else:
                print(f"ok  {name} ({'reprova' if should_fail else 'aprova'})")
            path.unlink()
    if failures:
        print(f"\n{failures} caso(s) de selftest fora do esperado.")
        return 1
    print(f"\n{len(SELFTEST_CASES)} casos de selftest conferem — a checagem sabe reprovar.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--default-branch", help="branch padrão do repositório")
    parser.add_argument("--dir", default=".github/workflows", help="pasta dos workflows")
    parser.add_argument("--selftest", action="store_true", help="prova que a checagem reprova")
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    if not args.default_branch:
        parser.error("--default-branch é obrigatório fora do --selftest")

    problems = scan(Path(args.dir), args.default_branch)
    if problems:
        print(f"Branch padrão: `{args.default_branch}`\n")
        for p in problems:
            print(f"::error::{p}")
        print(
            "\nUm workflow que nunca dispara parece aprovado. Inclua a branch padrão "
            "na lista, ou apague o arquivo."
        )
        return 1

    print(f"Todos os workflows disparam na branch padrão `{args.default_branch}`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
