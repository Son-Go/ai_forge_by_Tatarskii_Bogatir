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


def validate_model_json[Output: BaseModel](
    schema: type[Output], body: str | bytes, stage: str
) -> Output:
    try:
        return schema.model_validate_json(body)
    except ValidationError as error:
        details = error.errors(include_input=False, include_context=False, include_url=False)
        codes = ",".join(sorted({item["type"] for item in details}))
        raise InvalidModelOutput(f"{stage}:{codes}") from None
