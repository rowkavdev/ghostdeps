package color

import "github.com/mattn/go-isatty"

var NoColor = isatty.IsTerminal(0)

func Red(format string, a ...interface{}) {}
