using Microsoft.AspNetCore.Components;

class PreviewComponent {
    [Parameter] public string Content { get; set; } = "";

    public MarkupString Render() {
        return (MarkupString)Content;
    }
}
