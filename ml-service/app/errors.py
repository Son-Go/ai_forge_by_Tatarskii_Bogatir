import json

from pydantic import BaseModel, ValidationError


class ServiceError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class InvalidModelOutput(ServiceError):
    def __init__(self, reason: str) -> None:
        super().__init__("MODEL_INVALID_OUTPUT", "Ответ модели не соответствует контракту.")
        self.reason = reason


def unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    values = dict(pairs)
    if len(values) != len(pairs):
        raise ValueError("Duplicate JSON keys")
    return values


def validate_model_json[Output: BaseModel](
    schema: type[Output], body: str | bytes, stage: str, *, reject_duplicate_keys: bool = False
) -> Output:
    if reject_duplicate_keys:
        try:
            json.loads(body, object_pairs_hook=unique_json_object)
        except (ValueError, RecursionError):
            raise InvalidModelOutput(f"{stage}:invalid_json") from None
    try:
        return schema.model_validate_json(body)
    except ValidationError as error:
        details = error.errors(include_input=False, include_context=False, include_url=False)
        codes = ",".join(sorted({item["type"] for item in details}))
        raise InvalidModelOutput(f"{stage}:{codes}") from None
