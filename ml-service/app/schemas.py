from typing import Annotated, Literal, TypedDict

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, with_config

RequestId = Annotated[
    str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
]
PositiveInt = Annotated[int, Field(gt=0)]
NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
UserText = Annotated[str, StringConstraints(min_length=1, max_length=8_000, pattern=r"\S")]
Budget = Annotated[str, StringConstraints(pattern=r"^[0-9]+(\.[0-9]+)?$")]
Intent = Literal["known_product", "needs_solution", "product_question"]
Outcome = Literal["clarify", "recommend", "answer", "insufficient_data"]
LicenseKind = Literal["new", "renewal"]
TextField = Literal["product_name", "edition", "deployment", "platform", "use_case"]
IntegerField = Literal["seats", "license_term_months"]
RequirementField = Literal[
    TextField, IntegerField, "license_kind", "budget_rub", "domestic_required"
]


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True)


class ModelOutput(StrictModel):
    model_config = ConfigDict(extra="forbid")


@with_config(ConfigDict(strict=True, extra="forbid"))
class Requirements(TypedDict, total=False):
    product_name: str
    edition: str
    license_kind: LicenseKind
    seats: PositiveInt
    license_term_months: PositiveInt
    deployment: str
    platform: str
    budget_rub: Budget
    domestic_required: bool
    use_case: str


class ConversationMessage(StrictModel):
    role: Literal["user", "assistant"]
    text: Annotated[str, StringConstraints(max_length=4_000)] = Field(serialization_alias="content")


class ModelRequest(StrictModel):
    request_id: RequestId
    deadline_ms: PositiveInt


class InterpretRequest(ModelRequest):
    text: UserText
    conversation_context: list[ConversationMessage] = Field(max_length=8)
    requirements: Requirements


class ClearUpdate(ModelOutput):
    op: Literal["clear"]
    field: RequirementField


class SetUpdate(ModelOutput):
    op: Literal["set"]
    evidence: Annotated[str, StringConstraints(min_length=1, max_length=240, pattern=r"\S")]


class SetText(SetUpdate):
    field: TextField
    value: NonBlank


class SetInteger(SetUpdate):
    field: IntegerField
    value: PositiveInt


class SetLicenseKind(SetUpdate):
    field: Literal["license_kind"]
    value: LicenseKind


class SetBudget(SetUpdate):
    field: Literal["budget_rub"]
    value: Budget


class SetDomesticRequired(SetUpdate):
    field: Literal["domestic_required"]
    value: bool


class Interpretation(ModelOutput):
    intent: Intent
    product_query: str | None
    updates: list[
        ClearUpdate | SetText | SetInteger | SetLicenseKind | SetBudget | SetDomesticRequired
    ]
    clarification_candidates: list[RequirementField]

    @field_validator("clarification_candidates")
    @classmethod
    def validate_unique_candidates(cls, fields: list[RequirementField]) -> list[RequirementField]:
        if len(fields) != len(set(fields)):
            raise ValueError("Duplicate clarification candidates")
        return fields


class InterpretResult(Interpretation):
    model_version: str


FactId = Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"\S")]


class Fact(StrictModel):
    id: FactId
    text: Annotated[str, StringConstraints(min_length=1, max_length=2_000, pattern=r"\S")]


class ComposeRequest(ModelRequest):
    outcome: Outcome
    facts: list[Fact] = Field(max_length=16)
    language: Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=32)]

    @field_validator("facts")
    @classmethod
    def validate_unique_facts(cls, facts: list[Fact]) -> list[Fact]:
        if len(facts) != len({fact.id for fact in facts}):
            raise ValueError("Duplicate fact IDs")
        return facts


class Block(ModelOutput):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000)]
    fact_ids: list[FactId] = Field(max_length=16)

    @field_validator("fact_ids")
    @classmethod
    def validate_unique_ids(cls, fact_ids: list[str]) -> list[str]:
        if len(fact_ids) != len(set(fact_ids)):
            raise ValueError("Duplicate fact IDs")
        return fact_ids


class Complete(StrictModel):
    model_version: str
    prompt_version: str


class Error(StrictModel):
    code: str
    message: str
    request_id: RequestId


class Health(StrictModel):
    status: Literal["up", "down"]
