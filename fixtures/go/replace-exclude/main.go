package main

import (
	"example.com/internal/shared"
	log "github.com/sirupsen/logrus"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func main() {
	log.Info(cases.Title(language.English).String(shared.Name()))
}
