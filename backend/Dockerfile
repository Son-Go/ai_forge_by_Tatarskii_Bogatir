FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml .
COPY src ./src
RUN mvn --batch-mode --no-transfer-progress package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /workspace/target/support-agent-0.1.0-SNAPSHOT.jar ./support-agent.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "support-agent.jar"]
