# syntax=docker/dockerfile:1
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/conv-svc ./...

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/conv-svc /conv-svc
EXPOSE 8082
USER nonroot:nonroot
ENTRYPOINT ["/conv-svc"]
