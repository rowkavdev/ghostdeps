module example.com/replaced

go 1.22

require (
	github.com/sirupsen/logrus v1.9.3
	golang.org/x/text v0.14.0
	example.com/internal/shared v0.0.0
)

replace github.com/sirupsen/logrus => github.com/example-fork/logrus v1.9.4-fork

replace example.com/internal/shared => ./shared

exclude golang.org/x/text v0.13.0
