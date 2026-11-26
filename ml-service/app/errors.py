class ServiceError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class InvalidModelOutput(ServiceError):
    def __init__(self) -> None:
        super().__init__("MODEL_INVALID_OUTPUT", "Ответ модели не соответствует контракту.")
