import argparse
import json
import sys

try:
    import argostranslate.package
    import argostranslate.translate
except ImportError as exc:
    print(json.dumps({"error": f"argostranslate not available: {exc}"}))
    sys.exit(1)


def ensure_package(source_code, target_code):
    installed_packages = argostranslate.package.get_installed_packages()
    for pkg in installed_packages:
        if pkg.from_code == source_code and pkg.to_code == target_code:
            return

    available_packages = argostranslate.package.get_available_packages()
    package_to_install = next(
        (
            pkg
            for pkg in available_packages
            if pkg.from_code == source_code and pkg.to_code == target_code
        ),
        None,
    )

    if package_to_install is None:
        raise RuntimeError(f"No Argos Translate package for {source_code}->{target_code}")

    download_path = package_to_install.download()
    argostranslate.package.install_from_path(download_path)


def get_translation(source_code, target_code):
    ensure_package(source_code, target_code)
    languages = argostranslate.translate.load_installed_languages()
    from_lang = next((lang for lang in languages if lang.code == source_code), None)
    to_lang = next((lang for lang in languages if lang.code == target_code), None)

    if from_lang is None or to_lang is None:
        raise RuntimeError(f"Unable to load languages {source_code}->{target_code}")

    return from_lang.get_translation(to_lang)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    args = parser.parse_args()

    try:
        texts = json.load(sys.stdin)
    except json.JSONDecodeError:
        print(json.dumps({"error": "Invalid JSON payload"}))
        sys.exit(1)

    if not isinstance(texts, list):
        print(json.dumps({"error": "Expected a list of strings"}))
        sys.exit(1)

    source = args.source.lower()
    target = args.target.lower()

    if source == target:
        print(json.dumps(texts, ensure_ascii=False))
        return

    try:
        translation = get_translation(source, target)
        translated = [translation.translate(text or '') for text in texts]
        print(json.dumps(translated, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == '__main__':
    main()

