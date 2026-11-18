"""Regression gates for Drupal, Yii, and Hanami reviewer guidance."""

from pathlib import Path


ROOT = Path(__file__).parent.parent


def _reviewer(name: str) -> str:
    return (ROOT / "sub-skills" / name).read_text()


def test_php_reviewer_has_actionable_drupal_guidance():
    reviewer = _reviewer("php-security-reviewer.md")
    required = (
        "*.routing.yml",
        "_entity_access",
        "_custom_access",
        "accessCheck(FALSE)",
        "AccessResult",
        "cacheability",
        "_csrf_token",
        "Form API",
        "Entity::create",
        "Connection::query",
        "#markup",
        "Markup::create",
        "http_client",
        "private://",
        "QueueWorker",
        "trusted-host",
    )
    for marker in required:
        assert marker in reviewer, f"missing Drupal guidance: {marker}"


def test_php_reviewer_has_actionable_yii_guidance():
    reviewer = _reviewer("php-security-reviewer.md")
    required = (
        "ActiveController",
        "beforeAction",
        "AccessControl",
        "VerbFilter",
        "Yii::$app->user->can()",
        "enableCsrfValidation = false",
        "Model::load()",
        "setAttributes()",
        "active scenario",
        r"yii\\db\\Expression",
        "Html::encode()",
        "UploadedFile",
        "cookieValidationKey",
        "debug/Gii",
    )
    for marker in required:
        assert marker in reviewer, f"missing Yii guidance: {marker}"


def test_ruby_reviewer_has_actionable_hanami_guidance():
    reviewer = _reviewer("ruby-security-reviewer.md")
    required = (
        "config/routes.rb",
        "app or slice",
        "parameter contracts",
        "session and CSRF middleware",
        "ROM commands",
        "repositories",
        "Sequel.lit",
        "gateway/raw SQL",
        "actual renderer/template-engine",
        "upload adapters",
        "settings/providers",
        "job adapters/command consumers",
        "request-scoped Hanami dependencies",
        "actor/tenant enforcement",
    )
    for marker in required:
        assert marker in reviewer, f"missing Hanami guidance: {marker}"
